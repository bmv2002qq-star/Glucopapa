#include <jni.h>
#include "llama.h"
#include <algorithm>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

// JNI uses a single Java-side executor so only one model is loaded at a time.
static jstring result(JNIEnv * env, const std::string & text) {
    // NewStringUTF expects modified UTF-8; regular UTF-8 Russian text usually works.
    return env->NewStringUTF(text.c_str());
}
static void set_batch(llama_batch_ext * batch,const llama_token * tokens,int32_t n,llama_pos start){
    llama_batch_ext_clear(batch);
    for(int32_t i=0;i<n;i++) {
        const int32_t idx=llama_batch_ext_add_token(batch,0,tokens[i]);
        const llama_pos pos=start+i;
        llama_batch_ext_set_pos(batch,idx,&pos);
    }
    llama_batch_ext_set_output_logits(batch,n-1,true);
}
extern "C" JNIEXPORT jstring JNICALL
Java_ru_family_glucodiary_LocalLlm_nativeGenerate(JNIEnv* env,jclass,jstring pathJava,jstring promptJava,jint maxTokens){
    if(!pathJava || !promptJava)return result(env,"ОШИБКА: пустой путь или запрос");
    const char * path=env->GetStringUTFChars(pathJava,nullptr);
    const char * promptC=env->GetStringUTFChars(promptJava,nullptr);
    if(!path || !promptC){if(path)env->ReleaseStringUTFChars(pathJava,path);if(promptC)env->ReleaseStringUTFChars(promptJava,promptC);return result(env,"ОШИБКА: память");}
    std::string file(path),prompt(promptC);
    env->ReleaseStringUTFChars(pathJava,path);
    env->ReleaseStringUTFChars(promptJava,promptC);
    if(file.empty() || prompt.empty() || prompt.size()>18000)return result(env,"ОШИБКА: неверный запрос");
    int outputLimit=std::clamp((int)maxTokens,16,360);
    llama_backend_init();
    llama_model_params mp=llama_model_default_params();mp.n_gpu_layers=0;
    llama_model* model=llama_model_load_from_file(file.c_str(),mp);
    if(!model)return result(env,"ОШИБКА: не удалось загрузить GGUF");
    const llama_vocab* vocab=llama_model_get_vocab(model);
    int required=-llama_tokenize(vocab,prompt.c_str(),prompt.size(),nullptr,0,false,true);
    if(required<=0||required>3100){llama_model_free(model);return result(env,"ОШИБКА: запрос слишком длинный");}
    std::vector<llama_token> tokens(required);
    if(llama_tokenize(vocab,prompt.c_str(),prompt.size(),tokens.data(),required,false,true)<0){llama_model_free(model);return result(env,"ОШИБКА: токенизация");}
    llama_context_params cp=llama_context_default_params();cp.n_ctx=4096;cp.n_batch=2048;cp.n_threads=3;cp.n_threads_batch=3;
    llama_context* ctx=llama_init_from_model(model,cp);
    if(!ctx){llama_model_free(model);return result(env,"ОШИБКА: не хватает памяти для контекста");}
    llama_batch_ext* batch=llama_batch_ext_init(ctx);
    auto params=llama_sampler_chain_default_params();
    llama_sampler* sampler=llama_sampler_chain_init(params);
    llama_sampler_chain_add(sampler,llama_sampler_init_greedy());
    std::string output;
    set_batch(batch,tokens.data(),required,0);
    llama_pos pos=0;int count=required;
    for(int step=0;step<outputLimit;step++){
        if(llama_process(ctx,LLAMA_PROCESS_TYPE_DECODE,batch)!=0) {output="ОШИБКА: обработка токенов";break;}
        pos+=count;
        llama_token id=llama_sampler_sample(sampler,ctx,-1);
        if(llama_vocab_is_eog(vocab,id))break;
        char buf[1024];int n=llama_token_to_piece(vocab,id,buf,sizeof(buf),0,true);
        if(n<0){output="ОШИБКА: декодирование";break;}
        if(output.size()+n>7000)break;
        output.append(buf,n);
        set_batch(batch,&id,1,pos);count=1;
    }
    llama_sampler_free(sampler);
    llama_batch_ext_free(batch);
    llama_free(ctx);
    llama_model_free(model);
    if(output.rfind("ОШИБКА:",0)==0)return result(env,output);
    return result(env,output);
}
