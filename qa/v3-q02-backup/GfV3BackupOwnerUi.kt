package org.glukopapa.v3.m00

import android.app.Activity
import android.app.AlertDialog
import android.text.InputType
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.LinearLayout
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

/** Q02 native owner-consent gateway. JavaScript cannot send passwords, file paths,
 * SQL, revision, or an operator identity to the native backup engine.
 * Local encrypted copies are private; external SAF export/import is Q29.
 */
internal class GfV3BackupOwnerUi(
    private val activity:Activity,
    private val service:GfV3EncryptedSnapshot,
    private val automatic:GfV3AutoLocalBackup,
    private val storage:GfV3Storage,
    private val onRestored:()->Unit
) {
    private val executor=Executors.newSingleThreadExecutor()
    private val statuses=ConcurrentHashMap<String,JSONObject>()
    @Volatile private var busy=false
    @Volatile private var destroyed=false

    private fun state(ticket:String,status:String,info:String="") {
        statuses[ticket]=JSONObject().put("status",status).put("message",info)
        if(statuses.size>16) statuses.keys.firstOrNull()?.let { statuses.remove(it) }
    }
    fun request(action:String):String {
        require(action=="create"||action=="restore") {"Q02_ACTION_DENIED"}
        check(!destroyed){"Q02_ACTIVITY_DESTROYED"}
        synchronized(this){check(!busy){"Q02_BUSY"};busy=true}
        val ticket=UUID.randomUUID().toString()
        state(ticket,"WAITING_OWNER")
        activity.runOnUiThread {
            if(destroyed){finish(ticket,"CANCELLED");return@runOnUiThread}
            if(action=="create") promptPassword(ticket,false,null)
            else {
                val items=(service.listLocalEncrypted()+automatic.list())
                if(items.isEmpty()){
                    AlertDialog.Builder(activity).setTitle("Резервные копии")
                        .setMessage("Локальных зашифрованных копий пока нет.")
                        .setPositiveButton("Понятно") {_,_->finish(ticket,"NO_BACKUPS")}
                        .setOnCancelListener{finish(ticket,"CANCELLED")}.show()
                } else AlertDialog.Builder(activity).setTitle("Выбрать копию для восстановления")
                    .setItems(items.toTypedArray()){_,idx->
                        if(items[idx].endsWith(".gpv3auto")) promptAutoRestore(ticket,items[idx])
                        else promptPassword(ticket,true,items[idx])
                    }
                    .setNegativeButton("Отмена"){_,_->finish(ticket,"CANCELLED")}
                    .setOnCancelListener{finish(ticket,"CANCELLED")}.show()
            }
        }
        return ticket
    }
    fun poll(ticket:String):String {
        require(Regex("^[0-9a-f-]{36}$").matches(ticket)) {"Q02_TICKET_INVALID"}
        return statuses[ticket]?.toString()?:JSONObject().put("status","UNKNOWN_TICKET").toString()
    }
    private fun finish(ticket:String,which:String,info:String="") {state(ticket,which,info);busy=false}
    private fun promptAutoRestore(ticket:String,fileName:String) {
        val revision=storage.revision()
        AlertDialog.Builder(activity).setTitle("Восстановить автоматическую копию")
            .setMessage("Копия зашифрована ключом Android этого устройства. Подтверди замену базы. Ревизия сейчас: $revision.")
            .setNegativeButton("Отмена"){_,_->finish(ticket,"CANCELLED")}
            .setOnCancelListener{finish(ticket,"CANCELLED")}
            .setPositiveButton("Восстановить"){_,_->
                state(ticket,"PROCESSING")
                executor.execute {
                    try{
                        val result=automatic.restoreLocal(fileName,revision)
                        finish(ticket,"DONE","Восстановлена ревизия ${result.revision}")
                        activity.runOnUiThread{onRestored()}
                    }catch(e:Exception){finish(ticket,"FAILED",e.message?:"AUTO_RESTORE_FAILED")}
                }
            }.show()
    }
    private fun promptPassword(ticket:String,restore:Boolean,fileName:String?) {
        val first=EditText(activity).apply{
            hint="Пароль не менее 12 символов"
            inputType=InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            isSingleLine=true
            importantForAutofill=View.IMPORTANT_FOR_AUTOFILL_NO
        }
        val confirm=EditText(activity).apply{
            hint="Повторите пароль"
            inputType=InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            isSingleLine=true
            importantForAutofill=View.IMPORTANT_FOR_AUTOFILL_NO
        }
        val panel=LinearLayout(activity).apply{
            orientation=LinearLayout.VERTICAL
            setPadding(35,18,35,8)
            addView(first,LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,ViewGroup.LayoutParams.WRAP_CONTENT))
            if(!restore)addView(confirm,LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,ViewGroup.LayoutParams.WRAP_CONTENT))
        }
        val builder=AlertDialog.Builder(activity)
            .setTitle(if(restore)"Восстановить зашифрованную копию" else "Создать защищённую копию")
            .setMessage(if(restore)"Введите пароль выбранной копии. Действующая база будет заменена только после проверки целостности и подтверждения." else "Пароль нужен для переносимой копии. Он не сохраняется в приложении.")
            .setView(panel)
            .setNegativeButton("Отмена"){_,_->finish(ticket,"CANCELLED")}
            .setOnCancelListener{finish(ticket,"CANCELLED")}
        builder.setPositiveButton(if(restore)"Проверить копию" else "Создать копию") {_,_->
            val input=first.text.toString().toCharArray()
            val second=if(restore)CharArray(0) else confirm.text.toString().toCharArray()
            val matches=restore||input.contentEquals(second)
            first.text?.clear();confirm.text?.clear();second.fill('\u0000')
            if(input.size<12||!matches){input.fill('\u0000');finish(ticket,"INVALID_PASSWORD","Требуется пароль не менее 12 символов и совпадение подтверждения.")}
            else if(restore) {
                val rev=storage.revision()
                AlertDialog.Builder(activity).setTitle("Подтвердить восстановление")
                    .setMessage("Заменить текущие данные проверенной копией? Действие требует твоего подтверждения. Текущая ревизия: $rev.")
                    .setNegativeButton("Отмена"){_,_->input.fill('\u0000');finish(ticket,"CANCELLED")}
                    .setOnCancelListener{input.fill('\u0000');finish(ticket,"CANCELLED")}
                    .setPositiveButton("Восстановить") {_,_->
                        state(ticket,"PROCESSING")
                        executor.execute {
                            try{
                                val r=service.restoreLocalEncrypted(fileName!!,input,rev)
                                finish(ticket,"DONE","Восстановлена ревизия ${r.revision}")
                                activity.runOnUiThread { onRestored() }
                            }catch(e:Exception){finish(ticket,"FAILED",e.message?:"BACKUP_RESTORE_FAILED")}
                            finally{input.fill('\u0000')}
                        }
                    }.show()
            } else {
                state(ticket,"PROCESSING")
                executor.execute {
                    try{val r=service.createLocalEncrypted(input);finish(ticket,"DONE","Создана защищённая копия ${r.fileName}, ревизия ${r.revision}")}
                    catch(e:Exception){finish(ticket,"FAILED",e.message?:"BACKUP_CREATE_FAILED")}
                    finally{input.fill('\u0000')}
                }
            }
        }
        builder.show()
    }
    fun shutdown(){destroyed=true;executor.shutdownNow();statuses.clear();busy=false}
}
