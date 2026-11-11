package ru.family.glucodiary;

import org.json.JSONArray;
import org.json.JSONObject;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Explicit on-device context for the small offline language model.
 * Uses only locally recorded facts, never sends data to a cloud service,
 * and never calculates or proposes an insulin dose or therapeutic coefficient.
 * Data is read from the SQLite snapshot when the parent presses Analyze.
 */
final class AiObservationContext {
    static final long HOUR=3_600_000L, DAY=24*HOUR;
    private static final int MAX_CGM_POINTS=16, MAX_INJECTIONS=12, MAX_MEALS=8, MAX_ACTIVITY=5;
    private AiObservationContext() {}

    static String build(JSONObject snapshot, long now) {
        if(snapshot==null) snapshot=new JSONObject();
        StringBuilder out=new StringBuilder(12000);
        SimpleDateFormat fmtTime=new SimpleDateFormat("dd.MM HH:mm",Locale.ROOT);
        out.append("ЛОКАЛЬНЫЙ КОНТЕКСТ ДНЕВНИКА (время устройства: ").append(fmtTime.format(new Date(now))).append(")\n");
        out.append("ПРОФИЛЬ (данные из настроек; не являются основанием для дозировки): ");
        JSONObject p=snapshot.optJSONObject("profile");
        if(p==null) p=new JSONObject();
        out.append("возраст ").append(numOrMissing(p,"age",0,120," лет"))
           .append("; рост ").append(numOrMissing(p,"height",30,250," см"))
           .append("; масса ").append(numOrMissing(p,"weight",1,250," кг"))
           .append("; пол ").append(plainSex(p.optString("sex")))
           .append("; обычная активность ").append(plainActivity(p.optString("activity"))).append(".\n");
        JSONObject goals=p.optJSONObject("nutrition");
        if(goals!=null)out.append("Пищевые цели, заданные в приложении: Б ").append(numOrMissing(goals,"protein",0,500," г"))
                .append("; Ж ").append(numOrMissing(goals,"fat",0,500," г"))
                .append("; У ").append(numOrMissing(goals,"carbs",0,1000," г"))
                .append("; энергия ").append(numOrMissing(goals,"kcal",0,6000," ккал")).append(".\n");
        String allergies=clean(p.optString("allergies",""),120);
        if(!allergies.isEmpty())out.append("Записанные аллергии/непереносимости: ").append(allergies).append(".\n");
        JSONObject insulin=p.optJSONObject("insulinPresets");
        out.append("ПРЕПАРАТЫ из настроек: ");
        out.append("короткий ").append(insulinName(insulin,"short",p.optString("shortInsulin")))
           .append("; базальный ").append(insulinName(insulin,"long",p.optString("longInsulin"))).append(". Названия не подтверждают факт инъекции.\n");
        out.append("СПРАВОЧНЫЕ ПРОФИЛИ ДЕЙСТВИЯ ПРЕПАРАТОВ (усреднённые, не для расчёта дозы):\n");
        out.append("  ").append(InsulinActionProfiles.describe("short",insulin,p)).append("\n");
        out.append("  ").append(InsulinActionProfiles.describe("long",insulin,p)).append("\n");
        out.append("Наложение профилей инъекций — возможное совместное действие, а не автоматически вычисленный остаток IOB.\n");
        out.append("Отметка болезни: ").append(snapshot.optBoolean("ill",false)?"да":"нет отметки").append(".\n");

        JSONArray rows=snapshot.optJSONArray("readings");
        List<JSONObject> recent=new ArrayList<>(),prior=new ArrayList<>(),lastWeek=new ArrayList<>();
        if(rows!=null)for(int i=0;i<rows.length();i++){
            JSONObject r=rows.optJSONObject(i);if(r==null)continue;
            long ts=r.optLong("ts",0);double v=r.optDouble("mmol",Double.NaN);
            if(ts<=0||ts>now+120000||!Double.isFinite(v)||v<1||v>35)continue;
            if(ts>=now-7*DAY)lastWeek.add(r);
            if(ts>=now-8*HOUR)recent.add(r);
            else if(ts>=now-24*HOUR)prior.add(r);
        }
        recent.sort(Comparator.comparingLong(o->o.optLong("ts")));
        // Typical xDrip+ data is a reading every ~5 min. In case of denser input,
        // keep one reading per five-minute bucket so all eight hours are covered.
        Map<Long,JSONObject> buckets=new LinkedHashMap<>();
        for(JSONObject r:recent)buckets.put((r.optLong("ts")-(now-8*HOUR))/(5*60_000L),r);
        List<JSONObject> series=new ArrayList<>(buckets.values());
        if(series.size()>MAX_CGM_POINTS)series=sampleEvenly(series,MAX_CGM_POINTS);
        out.append("CGM xDrip+ ЗА ПОСЛЕДНИЕ 8 ЧАСОВ: получено ").append(recent.size())
           .append(" показаний; выборка до 16 точек в ммоль/л за 8 часов (полный ряд использован для статистики).\n");
        if(series.isEmpty())out.append("Нет показаний CGM в выбранном окне.\n");
        else {
            out.append("Ряд: ");
            for(int i=0;i<series.size();i++){
                JSONObject r=series.get(i);
                if(i>0)out.append(' ');
                out.append(timeOnly(r.optLong("ts"))).append('=').append(d1(r.optDouble("mmol")));
            }
            out.append(".\n");
            out.append("8ч статистика: ").append(stat(recent)).append("; последняя точка ")
               .append(timeOnly(recent.get(recent.size()-1).optLong("ts"))).append("; возраст ")
               .append((now-recent.get(recent.size()-1).optLong("ts"))/60_000L)
               .append(" мин; разрывов >15 мин ").append(countGaps(recent,15*60_000L)).append(".\n");
        }
        out.append("ПРЕДШЕСТВУЮЩИЕ 16 ЧАСОВ CGM (до начала 8ч окна): ")
           .append(prior.isEmpty()?"нет записей":stat(prior)).append(".\n");
        out.append("ОБЗОР 7 ДНЕЙ CGM: ")
           .append(lastWeek.isEmpty()?"нет записей":stat(lastWeek)).append(".\n");

        JSONArray events=snapshot.optJSONArray("events");
        List<JSONObject> injections=new ArrayList<>(),meals=new ArrayList<>(),activities=new ArrayList<>(),notes=new ArrayList<>();
        if(events!=null)for(int i=0;i<events.length();i++){
            JSONObject e=events.optJSONObject(i);if(e==null)continue;
            long ts=e.optLong("ts",0);if(ts<=0||ts>now+120000)continue;
            String type=e.optString("type");
            if(type.equals("insulin")&&ts>=now-48*HOUR)injections.add(e);
            if(type.equals("meal")&&ts>=now-24*HOUR)meals.add(e);
            if(type.equals("activity")&&ts>=now-48*HOUR)activities.add(e);
            if(type.equals("note")&&ts>=now-24*HOUR)notes.add(e);
        }
        Comparator<JSONObject> byTime=Comparator.comparingLong(e->e.optLong("ts"));
        injections.sort(byTime);meals.sort(byTime);activities.sort(byTime);notes.sort(byTime);
        out.append("ФАКТИЧЕСКИЕ ИНЪЕКЦИИ ЗА 48 ЧАСОВ (записи родителя, включая длинный инсулин): ")
           .append(injections.size()).append(".\n");
        int from=Math.max(0,injections.size()-MAX_INJECTIONS);
        for(int i=from;i<injections.size();i++){
            JSONObject e=injections.get(i);
            out.append("  ").append(fmtTime.format(new Date(e.optLong("ts")))).append(" ")
               .append(e.optString("insulinType").equals("long")?"базальный":"короткий/тип не указан")
               .append(" ").append(clean(e.optString("insulinName"),45)).append(" ")
               .append(numOrMissing(e,"units",0.01,100," ЕД"))
               .append("; место: ").append(clean(e.optString("site", "не указано"),30)).append(".\n");
        }
        out.append("ЕДА ЗА 24 ЧАСА (план ≠ фактически съедено): ").append(meals.size()).append(" записей.\n");
        from=Math.max(0,meals.size()-MAX_MEALS);
        for(int i=from;i<meals.size();i++){
            JSONObject e=meals.get(i);
            out.append("  ").append(fmtTime.format(new Date(e.optLong("ts")))).append(" ")
               .append(plainMealStatus(e.optString("status"))).append(" ")
               .append("У ").append(numOrMissing(e,"carbs",0,3000,"г"))
               .append(" Б ").append(numOrMissing(e,"protein",0,3000,"г"))
               .append(" Ж ").append(numOrMissing(e,"fat",0,3000,"г"))
               .append(" К ").append(numOrMissing(e,"kcal",0,10000,"ккал"));
            String foodNames=foods(e.optString("itemsJson",""),e.optString("name",""));
            if(!foodNames.isEmpty())out.append("; блюда ").append(foodNames);
            out.append(".\n");
        }
        out.append("АКТИВНОСТЬ ЗА 48 ЧАСОВ: ").append(activities.size()).append(" записей.\n");
        from=Math.max(0,activities.size()-MAX_ACTIVITY);
        for(int i=from;i<activities.size();i++){
            JSONObject e=activities.get(i);
            out.append("  ").append(fmtTime.format(new Date(e.optLong("ts")))).append(" ")
               .append(clean(e.optString("level",e.optString("name")),25))
               .append("; ").append(numOrMissing(e,"durationMinutes",1,720," мин"))
               .append("; примечание ").append(clean(e.optString("note"),70)).append(".\n");
        }
        if(!notes.isEmpty()){
            out.append("ЗАМЕТКИ ЗА 24 ЧАСА: ").append(notes.size()).append(".\n");
            for(int i=Math.max(0,notes.size()-3);i<notes.size();i++){
                JSONObject e=notes.get(i);out.append("  ").append(fmtTime.format(new Date(e.optLong("ts")))).append(" ").append(clean(e.optString("note"),70)).append(".\n");
            }
        }
        out.append("ОГРАНИЧЕНИЯ: отсутствующая запись не доказывает отсутствия еды, активности или инъекции; ")
           .append("данные CGM могут запаздывать; ни одна величина не является предложением изменить лечение.\n");
        String text=out.toString();
        // Small Qwen 0.5B has limited practical prompt capacity on mobile.
        // Keep the most recent and relevant lines, explicitly mark partial context.
        final int MAX_CONTEXT_CHARS=5200;
        if(text.length()>MAX_CONTEXT_CHARS)
            return text.substring(0,MAX_CONTEXT_CHARS)+"\n[КОНТЕКСТ СОКРАЩЁН: часть старых записей опущена, выводы предварительны.]";
        return text;
    }
    private static String insulinName(JSONObject p,String key,String fallback){
        JSONObject o=p==null?null:p.optJSONObject(key);
        String name=o==null?fallback:o.optString("name",fallback);
        return name.trim().isEmpty()?"не указан":clean(name,45);
    }
    private static String clean(String value,int max){
        if(value==null)return "";
        String x=value.replaceAll("[\\r\\n\\t\\u0000-\\u001F]+"," ")
          .replace("<|im_start|>","").replace("<|im_end|>","").replace("<|assistant|>","");
        x=x.replaceAll("\\s+"," ").trim();
        return x.length()>max?x.substring(0,max):x;
    }
    private static String plainSex(String s){return s.equals("male")?"мальчик":s.equals("female")?"девочка":"не указан";}
    private static String plainActivity(String s){return s.equals("very")?"очень высокая":s.equals("active")?"активная":s.equals("low")?"невысокая":s.equals("sedentary")?"малоподвижная":"не указана";}
    private static String plainMealStatus(String s){return s.equals("planned")?"ПЛАН":s.equals("started")?"НАЧАТА":s.equals("eaten")?"СЪЕДЕНА":"статус неизвестен";}
    private static String numOrMissing(JSONObject o,String key,double lo,double hi,String unit){
        double d=o.optDouble(key,Double.NaN);
        return Double.isFinite(d)&&d>=lo&&d<=hi?d1(d)+unit:"не указано";
    }
    private static String d1(double n){return String.format(Locale.ROOT,"%.1f",n);}
    private static String timeOnly(long ts){return new SimpleDateFormat("HH:mm",Locale.ROOT).format(new Date(ts));}
    private static String stat(List<JSONObject> series){
        double mn=Double.POSITIVE_INFINITY,mx=Double.NEGATIVE_INFINITY,sum=0;
        for(JSONObject r:series){double n=r.optDouble("mmol");mn=Math.min(n,mn);mx=Math.max(n,mx);sum+=n;}
        return "n="+series.size()+"; мин="+d1(mn)+"; макс="+d1(mx)+"; среднее="+d1(sum/series.size())+" ммоль/л";
    }
    private static int countGaps(List<JSONObject> list,long ms){
        int gaps=0;for(int i=1;i<list.size();i++)if(list.get(i).optLong("ts")-list.get(i-1).optLong("ts")>ms)gaps++;
        return gaps;
    }
    private static List<JSONObject> sampleEvenly(List<JSONObject> list,int limit){
        List<JSONObject> chosen=new ArrayList<>();
        for(int i=0;i<limit;i++)chosen.add(list.get((int)Math.round(i*(list.size()-1.0)/(limit-1.0))));
        return chosen;
    }
    private static String foods(String itemsJson,String fallback){
        List<String> names=new ArrayList<>();
        try {
            JSONArray arr=new JSONArray(itemsJson);
            for(int i=0;i<arr.length()&&i<5;i++){
                JSONObject o=arr.optJSONObject(i);if(o==null)continue;
                String n=clean(o.optString("name"),28);if(n.isEmpty())continue;
                double grams=o.optDouble("grams",Double.NaN);
                names.add(n+(Double.isFinite(grams)&&grams>0&&grams<5000?" "+d1(grams)+"г":""));
            }
        }catch(Exception ignored){}
        if(names.isEmpty())return clean(fallback,45);
        return String.join(", ",names);
    }
}
