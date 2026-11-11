package ru.family.glucodiary;

import org.json.JSONObject;

/** Non-prescriptive population profiles for an on-device diary assistant. */
final class InsulinActionProfiles {
    private static JSONObject reference = new JSONObject();
    private InsulinActionProfiles() {}

    static void setReference(JSONObject newReference) {
        if(newReference!=null)reference=newReference;
    }

    static String describe(String kind, JSONObject presets, JSONObject parent) {
        JSONObject chosen = presets==null?null:presets.optJSONObject(kind);
        String key=chosen==null?"":chosen.optString("key", "");
        JSONObject ref=reference.optJSONObject(key);
        String fallback=parent.optString(kind.equals("short")?"shortInsulin":"longInsulin", "не выбран");
        String name=chosen==null?fallback:chosen.optString("name",fallback);
        String onset=first(chosen,"onset",ref);
        String peak=first(chosen,"peak",ref);
        String duration=first(chosen,"duration",ref);
        String curve=ref==null?"описание не найдено":ref.optString("curve", "описание не найдено");
        String source=ref==null?"пользовательский препарат":ref.optString("sourceType", "источник не указан");
        return clean(name,60)+": начало "+clean(onset,110)+"; максимум "+clean(peak,140)+
            "; длительность "+clean(duration,100)+"; форма действия "+clean(curve,450)+
            "; происхождение данных: "+clean(source,100)+".";
    }
    private static String first(JSONObject custom,String key,JSONObject ref) {
        String a=custom==null?"":custom.optString(key, "");
        return !a.trim().isEmpty()?a:(ref==null?"не указано":ref.optString(key, "не указано"));
    }
    private static String clean(String value,int max) {
        if(value==null)return "";
        String x=value.replaceAll("[\\r\\n\\t\\u0000-\\u001F]+", " ").replaceAll("\\s+", " ").trim();
        return x.length()>max?x.substring(0,max):x;
    }
}
