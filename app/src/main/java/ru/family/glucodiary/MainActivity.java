package ru.family.glucodiary;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.os.Bundle;
import android.content.Intent;
import android.net.Uri;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.graphics.pdf.PdfDocument;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Color;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.URL;
import java.net.HttpURLConnection;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Calendar;
import java.util.Locale;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

/**
 * Prototype: local diary and observational statistics only.
 * NEVER recommends, calculates, or adjusts insulin doses or therapy coefficients.
 */
public class MainActivity extends Activity {
    private static final int CREATE_REPORT=101;
    private static final int PICK_LOCAL_MODEL=102;
    private LocalLlm localLlm;
    private final java.util.concurrent.ExecutorService aiIo=Executors.newSingleThreadExecutor();
    private final java.util.concurrent.atomic.AtomicBoolean llmInferenceBusy=new java.util.concurrent.atomic.AtomicBoolean(false);
    private static final String XDRIP="http://127.0.0.1:17580/sgv.json?count=288";
    private static final double MGDL_PER_MMOL=18.0182;
    private WebView page;
    private DiaryDb database;
    private CloudDemo cloudDemo;
    private final ScheduledExecutorService io=Executors.newScheduledThreadPool(2);
    private ScheduledFuture<?> poll;
    private volatile String reportPeriod="day";
    private volatile String reportDate="";

    @SuppressLint({"SetJavaScriptEnabled", "JavascriptInterface"})
    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        database=new DiaryDb(this);
        cloudDemo=new CloudDemo(this);
        localLlm=new LocalLlm(this);
        page=new WebView(this);
        page.setBackgroundColor(Color.rgb(244,248,248));
        WebSettings s=page.getSettings();s.setJavaScriptEnabled(true);s.setDomStorageEnabled(true);
        s.setAllowContentAccess(false);
        s.setAllowFileAccess(true); // For trusted app/src/main/assets only
        s.setAllowFileAccessFromFileURLs(false);
        s.setAllowUniversalAccessFromFileURLs(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        page.setWebViewClient(new WebViewClient(){
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return request.getUrl()==null || !request.getUrl().toString().startsWith("file:///android_asset/");
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view,String url) {
                return url==null||!url.startsWith("file:///android_asset/");
            }
        });
        page.addJavascriptInterface(new Bridge(),"GlucoBridge");
        setContentView(page);
        page.loadUrl("file:///android_asset/index.html");
    }
    @Override protected void onResume() {
        super.onResume();
        if (poll==null || poll.isDone() || poll.isCancelled()) {
            poll=io.scheduleWithFixedDelay(this::loadXdrip,2,60,TimeUnit.SECONDS);
        }
    }
    @Override protected void onPause() {
        if(poll!=null){poll.cancel(false);poll=null;}
        super.onPause();
    }
    @Override protected void onDestroy() {
        if(poll!=null)poll.cancel(true);
        io.shutdownNow();
        aiIo.shutdownNow();
        if(page!=null){page.removeJavascriptInterface("GlucoBridge");page.destroy();}
        database.close();super.onDestroy();
    }
    private void script(String js) {runOnUiThread(()->{if(page!=null)page.evaluateJavascript(js,null);});}
    private void progress(String message){script("window.onCatalogProgress("+JSONObject.quote(message)+");");}
    private void pushGlucose(String message) {
        try {JSONObject payload=new JSONObject();payload.put("message",message);payload.put("readings",database.getSnapshot().optJSONArray("readings"));
            script("window.onGlucoseUpdate("+JSONObject.quote(payload.toString())+");");
        }catch(Exception ignored){}
    }

    private void loadXdrip() {
        HttpURLConnection c=null;
        try {
            c=(HttpURLConnection)new URL(XDRIP).openConnection();c.setConnectTimeout(4000);c.setReadTimeout(6000);c.setRequestMethod("GET");
            if(c.getResponseCode()!=200)throw new Exception("HTTP "+c.getResponseCode());
            String body=readString(c,800000);
            JSONArray items=new JSONArray(body);int valid=0;long newest=0;
            for(int i=0;i<items.length();i++){
                JSONObject o=items.optJSONObject(i);if(o==null)continue;
                double mgdl=o.optDouble("sgv",Double.NaN);long ts=o.optLong("date",0);
                if(ts<=0 || !Double.isFinite(mgdl)||mgdl<20||mgdl>600)continue;
                double mmol=mgdl/MGDL_PER_MMOL;database.addReading(ts,mmol,o.optString("direction",""));
                valid++;newest=Math.max(newest,ts);
            }
            if(valid==0)throw new Exception("Нет корректных показаний в ответе xDrip+");
            database.set("lastSync",Long.toString(System.currentTimeMillis()));
            String msg=System.currentTimeMillis()-newest>600000L?"Связь есть, но показания старше 10 минут":"xDrip+ подключён; показания получены: "+valid;
            database.set("glucoseInfo",msg);pushGlucose(msg);
        }catch(Exception e){
            String msg="xDrip+ недоступен: проверьте локальный Web Service в настройках xDrip+";
            database.set("glucoseInfo",msg);pushGlucose(msg);
        }finally{if(c!=null)c.disconnect();}
    }
    private static String readString(HttpURLConnection c,int maxBytes)throws Exception{
        try(BufferedReader r=new BufferedReader(new InputStreamReader(c.getInputStream(),StandardCharsets.UTF_8))){
            StringBuilder b=new StringBuilder();char[] chars=new char[8192];int n;
            while((n=r.read(chars))!=-1){b.append(chars,0,n);if(b.length()>maxBytes)throw new Exception("Too much response data");}
            return b.toString();
        }
    }
    private void fetchFoods() {
        int imported=0,tries=0;
        // Open Food Facts: ODbL open database, authoritative source remains the label on packaging.
        // Filter Belarus; not guaranteed that 2000 complete products exist there.
        for(int pageNumber=1;pageNumber<=35 && database.countFoods()<2000;pageNumber++) {
            HttpURLConnection c=null;
            try {
                String path="https://world.openfoodfacts.org/api/v2/search?countries_tags=en%3Abelarus&fields=code%2Cproduct_name%2Cproduct_name_ru%2Cnutriments%2Ccategories_tags%2Cbrands&page_size=100&page="+pageNumber;
                c=(HttpURLConnection)new URL(path).openConnection();c.setConnectTimeout(9000);c.setReadTimeout(13000);
                c.setRequestProperty("User-Agent","GlucoFamily/0.1 (parental food diary; contact via GitHub)");
                if(c.getResponseCode()!=200)throw new Exception("HTTP "+c.getResponseCode());
                JSONObject root=new JSONObject(readString(c,1200000));JSONArray list=root.optJSONArray("products");
                if(list==null || list.length()==0)break;
                int pageAdded=0;
                for(int i=0;i<list.length()&&database.countFoods()<2000;i++){
                    JSONObject item=list.optJSONObject(i);if(item==null)continue;
                    JSONObject n=item.optJSONObject("nutriments");if(n==null)continue;
                    String name=item.optString("product_name_ru","").trim();
                    if(name.length()<2)name=item.optString("product_name","").trim();
                    if(name.length()<2)continue;
                    double fat=n.optDouble("fat_100g",Double.NaN),carbs=n.optDouble("carbohydrates_100g",Double.NaN),protein=n.optDouble("proteins_100g",Double.NaN);
                    double kcal=n.optDouble("energy-kcal_100g",Double.NaN);
                    if(!Double.isFinite(kcal)){
                        double kJ=n.optDouble("energy_100g",Double.NaN);
                        if(Double.isFinite(kJ))kcal=kJ/4.184;
                    }
                    if(!Double.isFinite(fat)||!Double.isFinite(carbs)||!Double.isFinite(protein)||!Double.isFinite(kcal))continue;
                    JSONObject food=new JSONObject();food.put("name",name);food.put("category",category(item));food.put("protein",protein);food.put("fat",fat);food.put("carbs",carbs);food.put("kcal",kcal);
                    food.put("source","Open Food Facts · "+item.optString("brands","этикетка")+" · ODbL");food.put("code",item.optString("code",""));
                    if(database.addFood(food)>0){pageAdded++;imported++;}
                }
                tries++;
                if(pageNumber%2==0 || pageNumber==1)progress("Загружено "+database.countFoods()+" продуктов (страница "+pageNumber+"). Данные с упаковок требуют проверки.");
                if(pageAdded==0&&pageNumber>8&&tries>10)break;
            }catch(Exception ex){progress("Не удалось загрузить страницу "+pageNumber+": проверьте интернет или повторите позднее. Сейчас "+database.countFoods()+" продуктов.");break;}
            finally{if(c!=null)c.disconnect();}
        }
        progress("Готово: "+database.countFoods()+" продуктов. Новых: "+imported+". Цель 2000; количество зависит от доступности записей Open Food Facts для Беларуси.");
    }
    private static String category(JSONObject item){
        JSONArray cats=item.optJSONArray("categories_tags");String tags=cats==null?"":cats.toString().toLowerCase(Locale.ROOT);
        if(tags.contains("dair")||tags.contains("cheese")||tags.contains("yogurt")||tags.contains("milk"))return "Молочные";
        if(tags.contains("bread")||tags.contains("biscuit")||tags.contains("bakery"))return "Хлеб";
        if(tags.contains("cereal")||tags.contains("pasta")||tags.contains("rice"))return "Крупы";
        if(tags.contains("fruit")||tags.contains("berries"))return "Фрукты";
        if(tags.contains("vegetab")||tags.contains("legume"))return "Овощи";
        if(tags.contains("meat")||tags.contains("fish")||tags.contains("egg"))return "Мясо и рыба";
        if(tags.contains("drink")||tags.contains("beverage")||tags.contains("juice"))return "Напитки";
        if(tags.contains("chocolate")||tags.contains("sweets")||tags.contains("dessert"))return "Сладости";
        return "Другие продукты";
    }
    private void requestPdf(){requestPdf("day",new SimpleDateFormat("yyyy-MM-dd",Locale.ROOT).format(new Date()));}
    private void requestPdf(String period,String selected){
        if(!period.equals("month")&&!period.equals("day"))return;
        if(!selected.matches(period.equals("day")?"\\d{4}-\\d{2}-\\d{2}":"\\d{4}-\\d{2}"))return;
        reportPeriod=period;reportDate=selected;
        runOnUiThread(()->{Intent i=new Intent(Intent.ACTION_CREATE_DOCUMENT);i.addCategory(Intent.CATEGORY_OPENABLE);i.setType("application/pdf");
            i.putExtra(Intent.EXTRA_TITLE,"ГлюкоСемья_"+reportPeriod+"_"+reportDate+".pdf");
            startActivityForResult(i,CREATE_REPORT);
        });
    }
    @Override protected void onActivityResult(int requestCode,int resultCode,Intent data){
        super.onActivityResult(requestCode,resultCode,data);
        if(requestCode==PICK_LOCAL_MODEL){
            if(resultCode==RESULT_OK && data!=null && data.getData()!=null){
                Uri fileUri=data.getData();
                script("window.gfLocalAiResult("+JSONObject.quote("Импорт модели начат. Подожди, файл может занимать 500 МБ...")+");");
                aiIo.execute(()->{try{
                    String msg=localLlm.importFrom(fileUri);
                    script("window.gfLocalAiResult("+JSONObject.quote(msg)+");");
                }catch(Exception ex){script("window.gfLocalAiResult("+JSONObject.quote("Ошибка импорта: "+ex.getMessage())+");");}});
            }
            return;
        }
        if(requestCode==CREATE_REPORT && resultCode==RESULT_OK &&data!=null&&data.getData()!=null){
            Uri uri=data.getData();io.execute(()->{try(OutputStream stream=getContentResolver().openOutputStream(uri)){
                if(stream==null)throw new Exception("No output stream");generatePdf(stream);script("(function(){alert('Отчёт PDF сохранён');})();");
            }catch(Exception e){script("(function(){alert('Ошибка сохранения PDF');})();");}});
        }
    }
    private static String time(long ts){return new SimpleDateFormat("dd.MM HH:mm",new Locale("ru")).format(new Date(ts));}
    private void generatePdf(OutputStream stream)throws Exception {
        // Report includes only recorded facts. Planned meals are excluded from totals.
        String period=reportPeriod,date=reportDate;
        SimpleDateFormat dayFmt=new SimpleDateFormat("yyyy-MM-dd",Locale.ROOT);
        dayFmt.setLenient(false);
        Date fromDate=dayFmt.parse(period.equals("month")?date+"-01":date);
        Calendar cal=Calendar.getInstance();cal.setTime(fromDate);
        long from=cal.getTimeInMillis();
        cal.add(period.equals("month")?Calendar.MONTH:Calendar.DAY_OF_MONTH,1);
        long to=cal.getTimeInMillis();
        JSONArray events=database.eventsForPeriod(from,to);
        PdfDocument doc=new PdfDocument();Paint p=new Paint(Paint.ANTI_ALIAS_FLAG);
        int pageNo=1,y;PdfDocument.Page page=doc.startPage(new PdfDocument.PageInfo.Builder(595,842,pageNo).create());
        Canvas cv=page.getCanvas();y=pdfHeader(cv,p,pageNo);
        p.setColor(Color.rgb(23,55,62));p.setTextSize(11);
        cv.drawText(period.equals("month")?"Месячный отчёт: "+date:"Отчёт за день: "+date,32,y,p);y+=22;
        p.setTextSize(9);p.setColor(Color.DKGRAY);
        cv.drawText("Только записи и наблюдения; не для назначения инсулина",32,y,p);y+=22;
        drawPdfRow(cv,p,y,"Время", "Событие", "CGM", "Описание / состав");y+=19;
        double carbs=0,protein=0,fat=0,kcal=0,shortIns=0,longIns=0;int meals=0,shots=0;
        String lastDay="";
        for(int i=0;i<events.length();i++){
            JSONObject e=events.getJSONObject(i);
            long ts=e.optLong("ts",0);String eventDay=dayFmt.format(new Date(ts));
            String type=e.optString("type");
            if(!eventDay.equals(lastDay)){
                if(y>760){doc.finishPage(page);pageNo++;page=doc.startPage(new PdfDocument.PageInfo.Builder(595,842,pageNo).create());cv=page.getCanvas();y=pdfHeader(cv,p,pageNo);}
                p.setColor(Color.rgb(20,100,100));p.setTextSize(10);p.setFakeBoldText(true);
                cv.drawText(eventDay,32,y,p);p.setFakeBoldText(false);y+=17;lastDay=eventDay;
            }
            if(y>740){doc.finishPage(page);pageNo++;page=doc.startPage(new PdfDocument.PageInfo.Builder(595,842,pageNo).create());cv=page.getCanvas();y=pdfHeader(cv,p,pageNo);drawPdfRow(cv,p,y,"Время", "Событие", "CGM", "Описание / состав");y+=23;}
            JSONObject cgm=database.glucoseNearest(ts,12*60*1000L);
            String sugar=cgm.length()>0?String.format(Locale.ROOT,"%.1f %s",cgm.optDouble("mmol"),arrow(cgm.optString("direction"))):"нет";
            String eventType=type.equals("meal")?(e.optString("status").equals("planned")?"Еда (план)":e.optString("status").equals("started")?"Еда (начата)":"Еда"):
               type.equals("insulin")?"Инъекция":"Заметка";
            if(!e.optString("editHistory", "[]").equals("[]")) eventType += " (ред.)";
            String detail="";
            if(type.equals("meal")){
                if(!e.optString("status").equals("planned")&&!e.optString("status").equals("started")){
                    meals++;carbs+=e.optDouble("carbs");protein+=e.optDouble("protein");fat+=e.optDouble("fat");kcal+=e.optDouble("kcal");
                }
                StringBuilder names=new StringBuilder();
                String jsonItems=e.optString("itemsJson","");
                JSONArray items=new JSONArray(jsonItems.isEmpty()?"[]":jsonItems);
                for(int j=0;j<items.length();j++){
                    JSONObject item=items.optJSONObject(j);if(item==null)continue;
                    if(j>0)names.append(", ");names.append(item.optString("name")).append(' ').append(Math.round(item.optDouble("grams"))).append("г");
                }
                detail=(names.length()>0?names.toString():e.optString("name"));
            } else if(type.equals("insulin")){
                shots++;
                double u=e.optDouble("units");
                if(e.optString("insulinType").equals("short"))shortIns+=u;
                if(e.optString("insulinType").equals("long"))longIns+=u;
                detail=e.optString("insulinName")+" "+String.format(Locale.ROOT,"%.2f ЕД",u);
            } else detail=e.optString("note");
            drawPdfRow(cv,p,y,new SimpleDateFormat("HH:mm",Locale.ROOT).format(new Date(ts)),eventType,sugar,detail);y+=18;
            if(type.equals("meal")){
                if(y>760){doc.finishPage(page);pageNo++;page=doc.startPage(new PdfDocument.PageInfo.Builder(595,842,pageNo).create());cv=page.getCanvas();y=pdfHeader(cv,p,pageNo);}
                p.setColor(Color.GRAY);p.setTextSize(9);
                cv.drawText(String.format(Locale.ROOT,"У %.1f  Б %.1f  Ж %.1f г    %.0f ккал",e.optDouble("carbs"),e.optDouble("protein"),e.optDouble("fat"),e.optDouble("kcal")),55,y,p);y+=15;
            }
        }
        if(y>670){doc.finishPage(page);pageNo++;page=doc.startPage(new PdfDocument.PageInfo.Builder(595,842,pageNo).create());cv=page.getCanvas();y=pdfHeader(cv,p,pageNo);}
        y+=16;p.setColor(Color.rgb(22,58,62));p.setTextSize(12);p.setFakeBoldText(true);
        cv.drawText("Итого за период",32,y,p);p.setFakeBoldText(false);y+=23;
        p.setTextSize(10);
        cv.drawText(String.format(Locale.ROOT,"Короткий: %.2f ЕД    Длинный: %.2f ЕД",shortIns,longIns),32,y,p);y+=20;
        cv.drawText(String.format(Locale.ROOT,"Б: %.1f г   Ж: %.1f г   У: %.1f г   %.0f ккал",protein,fat,carbs,kcal),32,y,p);y+=20;
        cv.drawText("Приёмов пищи: "+meals+"     Инъекций: "+shots,32,y,p);y+=19;
        p.setTextSize(9);p.setColor(Color.GRAY);
        cv.drawText("Полнота данных зависит от заполнения дневника и связи с CGM.",32,y,p);
        doc.finishPage(page);doc.writeTo(stream);doc.close();
    }
    private static String arrow(String dir){
        if(dir==null)return "";
        if(dir.contains("Up"))return "↑";
        if(dir.contains("Down"))return "↓";
        if(dir.contains("Flat"))return "→";
        return "";
    }
    private static void drawPdfRow(Canvas cv,Paint p,int y,String a,String b,String c,String d){
        p.setColor(Color.rgb(37,65,68));p.setTextSize(9);
        cv.drawText(truncate(a,13),32,y,p);
        cv.drawText(truncate(b,22),94,y,p);
        cv.drawText(truncate(c,16),205,y,p);
        cv.drawText(truncate(d.replace('\n',' '),57),297,y,p);
    }
    private static String truncate(String s,int max){return s.length()>max?s.substring(0,max-1)+"…":s;}
    private static int pdfHeader(Canvas c,Paint p,int page){
        p.setColor(Color.rgb(20,142,136));c.drawRect(0,0,595,76,p);
        p.setColor(Color.WHITE);p.setTextSize(20);p.setFakeBoldText(true);c.drawText("ГлюкоСемья",32,45,p);p.setFakeBoldText(false);
        p.setTextSize(9);c.drawText("стр. "+page,540,45,p);p.setColor(Color.DKGRAY);return 112;
    }
    public final class Bridge {
        @JavascriptInterface public String getData(){return database.getSnapshot().toString();}
        @JavascriptInterface public String addEvent(String json){try{return Long.toString(database.addEvent(new JSONObject(json)));}catch(Exception e){return "-1";}}
        @JavascriptInterface public String addFood(String json){try{return Long.toString(database.addFood(new JSONObject(json)));}catch(Exception e){return "-1";}}
        @JavascriptInterface public boolean updateEvent(String id,String json){try{return database.updateEvent(Long.parseLong(id),new JSONObject(json));}catch(Exception ignored){return false;}}
        @JavascriptInterface public void removeEvent(String id){try{database.removeEvent(Long.parseLong(id));}catch(Exception ignored){}}
        @JavascriptInterface public void setIll(boolean ill){database.setIll(ill);}
        @JavascriptInterface public void refreshGlucose(){io.execute(MainActivity.this::loadXdrip);}
        @JavascriptInterface public void importCatalog(){io.execute(MainActivity.this::fetchFoods);}
        @JavascriptInterface public boolean setProfile(String data){try{new JSONObject(data);database.set("profile",data);return true;}catch(Exception ignored){return false;}}
        @JavascriptInterface public void saveDraft(String data){try{new JSONObject(data);database.set("draft",data);}catch(Exception ignored){}}
        @JavascriptInterface public void exportPdfForPeriod(String period,String date){requestPdf(period,date);}
        @JavascriptInterface public boolean cloudKeyConfigured(){return cloudDemo.configured();}
        @JavascriptInterface public void saveCloudKey(String key){
            io.execute(()->{try{cloudDemo.save(key);script("window.gfCloudResult("+JSONObject.quote("Ключ зашифрован и сохранён только на этом устройстве")+");");}
            catch(Exception e){script("window.gfCloudResult("+JSONObject.quote("Ошибка сохранения: проверь API-ключ")+");");}});
        }
        @JavascriptInterface public void deleteCloudKey(){cloudDemo.clear();script("window.gfCloudResult("+JSONObject.quote("API-ключ удалён из настроек")+");");}
        @JavascriptInterface public void testCloudOnSynthetic(){
            io.execute(()->{try{String answer=cloudDemo.testSynthetic();script("window.gfCloudResult("+JSONObject.quote(answer)+");");}
            catch(Exception e){script("window.gfCloudResult("+JSONObject.quote("Ошибка теста: "+e.getMessage())+");");}});
        }
        @JavascriptInterface public String localAiStatus(){return localLlm.status();}
        @JavascriptInterface public String localAiDiagnostics(){return localLlm.diagnosticJson();}
        @JavascriptInterface public void runLocalSelfTest(){
            if(!llmInferenceBusy.compareAndSet(false,true)){
                script("window.gf026SelfTestResult("+JSONObject.quote("Qwen уже выполняет другой запрос. Дождись ответа.")+");");
                return;
            }
            aiIo.execute(()->{
                try {
                    script("window.gf026LocalProgress("+JSONObject.quote("Самотест: загрузка модели GGUF и генерация ответа…")+");");
                    String message=localLlm.selfTest();
                    script("window.gf026SelfTestResult("+JSONObject.quote(message)+");");
                }catch(Throwable ex){
                    script("window.gf026SelfTestResult("+JSONObject.quote("Ошибка самотеста: "+ex.getMessage())+");");
                }finally {llmInferenceBusy.set(false);}
            });
        }

        @JavascriptInterface public boolean localAiReady(){return localLlm.configured();}
        @JavascriptInterface public void chooseLocalModel(){runOnUiThread(()->{
            Intent i=new Intent(Intent.ACTION_OPEN_DOCUMENT);
            i.addCategory(Intent.CATEGORY_OPENABLE);
            i.setType("*/*");
            startActivityForResult(i,PICK_LOCAL_MODEL);
        });}
        @JavascriptInterface public void clearLocalModel(){aiIo.execute(()->{
            localLlm.clear();script("window.gfLocalAiResult("+JSONObject.quote("Модель удалена с устройства")+");");
        });}
        @JavascriptInterface public void runLocalAnalysis(){
            if(!llmInferenceBusy.compareAndSet(false,true)){
                script("window.gfLocalAiResult("+JSONObject.quote("Qwen уже выполняет запрос. Второй запрос не ставится в очередь.")+");");
                return;
            }
            aiIo.execute(()->{
                try {
                    script("window.gf026LocalProgress("+JSONObject.quote("Qwen: подготовка контекста дневника…")+");");
                    try(java.io.InputStream in=getAssets().open("insulin_action_reference_v0.11.1.json")) {
                        java.io.ByteArrayOutputStream bytes=new java.io.ByteArrayOutputStream();
                        byte[] buf=new byte[8192];int read;
                        while((read=in.read(buf))!=-1)bytes.write(buf,0,read);
                        InsulinActionProfiles.setReference(new JSONObject(bytes.toString("UTF-8")));
                    }
                    String context=AiObservationContext.build(database.getSnapshot(),System.currentTimeMillis());
                    script("window.gf026LocalProgress("+JSONObject.quote("Qwen: контекст готов. Загрузка GGUF и генерация на телефоне…")+");");
                    String result=localLlm.analyze(context);
                    script("window.gfLocalAiResult("+JSONObject.quote(result)+");");
                }catch(Throwable ex){
                    script("window.gfLocalAiResult("+JSONObject.quote("Локальная модель: "+ex.getClass().getSimpleName()+": "+ex.getMessage())+");");
                }finally {llmInferenceBusy.set(false);}
            });
        }
        @JavascriptInterface public void exportPdf(){requestPdf();}
    }
}
