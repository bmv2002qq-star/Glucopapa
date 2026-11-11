package ru.family.glucodiary;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import org.json.JSONArray;
import org.json.JSONObject;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

/**
 * Only an API connectivity demonstration on synthetic, non-medical text.
 * Intentionally DOES NOT accept diary, CGM, child profile, drugs, insulin or free-form prompts.
 * All treatment-related LLM requests MUST remain disabled pending privacy/legal/clinical review.
 */
public final class CloudDemo {
    private static final String ALIAS="GlucoFamilyGroqDemoKey";
    private static final String STORE="glucofamily_groq_demo";
    private final Context context;
    CloudDemo(Context c){context=c.getApplicationContext();}
    private SharedPreferences prefs(){return context.getSharedPreferences(STORE,Context.MODE_PRIVATE);}
    private SecretKey key() throws Exception {
        KeyStore ks=KeyStore.getInstance("AndroidKeyStore");ks.load(null);
        java.security.Key existing=ks.getKey(ALIAS,null);
        if(existing instanceof SecretKey)return (SecretKey) existing;
        KeyGenerator kg=KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore");
        kg.init(new KeyGenParameterSpec.Builder(ALIAS,KeyProperties.PURPOSE_ENCRYPT|KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setKeySize(256).build());
        return kg.generateKey();
    }
    void save(String apiKey) throws Exception {
        String k=apiKey.trim();
        if(!k.startsWith("gsk_")||k.length()<15||k.length()>220 || k.contains("\n")||k.contains(" "))throw new IllegalArgumentException("Некорректный API-ключ");
        Cipher c=Cipher.getInstance("AES/GCM/NoPadding");c.init(Cipher.ENCRYPT_MODE,key());
        byte[] encrypted=c.doFinal(k.getBytes(StandardCharsets.UTF_8));
        boolean ok=prefs().edit().putString("iv",Base64.encodeToString(c.getIV(),Base64.NO_WRAP))
              .putString("data",Base64.encodeToString(encrypted,Base64.NO_WRAP)).commit();
        if(!ok)throw new Exception("Не удалось сохранить ключ");
    }
    boolean configured(){return prefs().contains("iv")&&prefs().contains("data");}
    void clear(){prefs().edit().remove("iv").remove("data").apply();}
    private String load() throws Exception {
        if(!configured())throw new IllegalStateException("Ключ отсутствует");
        byte[] iv=Base64.decode(prefs().getString("iv",""),Base64.NO_WRAP);
        byte[] raw=Base64.decode(prefs().getString("data",""),Base64.NO_WRAP);
        Cipher c=Cipher.getInstance("AES/GCM/NoPadding");c.init(Cipher.DECRYPT_MODE,key(),new GCMParameterSpec(128,iv));
        return new String(c.doFinal(raw),StandardCharsets.UTF_8);
    }
    String testSynthetic() throws Exception {
        String token=load();
        // This request is always the same synthetic non-medical task and never includes device data.
        JSONObject body=new JSONObject();body.put("model","openai/gpt-oss-20b");body.put("stream",false);
        JSONArray msgs=new JSONArray();
        msgs.put(new JSONObject().put("role","system").put("content","You are testing a nutrition application. No medical recommendations or personal information. Answer briefly in Russian."));
        msgs.put(new JSONObject().put("role","user").put("content","Проверка подключения: назови три обычных овоща. Никаких сведений о людях, сахаре, инсулине или болезнях."));
        body.put("messages",msgs);body.put("max_tokens",150);
        HttpURLConnection conn=null;
        try {
            conn=(HttpURLConnection)new URL("https://api.groq.com/openai/v1/chat/completions").openConnection();
            conn.setRequestMethod("POST");conn.setConnectTimeout(9000);conn.setReadTimeout(15000);conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type","application/json");conn.setRequestProperty("Authorization","Bearer "+token);
            try(OutputStream out=conn.getOutputStream()){out.write(body.toString().getBytes(StandardCharsets.UTF_8));}
            int code=conn.getResponseCode();
            if(code!=200)throw new Exception("API вернул HTTP "+code+" (проверь баланс, модель и ключ)");
            StringBuilder resp=new StringBuilder();
            try(BufferedReader br=new BufferedReader(new InputStreamReader(conn.getInputStream(),StandardCharsets.UTF_8))){
                char[] buf=new char[2048];int n;
                while((n=br.read(buf))>=0){resp.append(buf,0,n);if(resp.length()>50000)throw new Exception("Слишком большой ответ");}
            }
            JSONArray choices=new JSONObject(resp.toString()).optJSONArray("choices");
            JSONObject ch=choices==null?null:choices.optJSONObject(0);
            JSONObject msg=ch==null?null:ch.optJSONObject("message");
            String answer=msg==null?"Подключение выполнено, но нет текста":"Тест успешен. Ответ: "+msg.optString("content","Нет ответа");
            return answer.length()>700?answer.substring(0,700):answer;
        }finally{if(conn!=null)conn.disconnect();}
    }
}
