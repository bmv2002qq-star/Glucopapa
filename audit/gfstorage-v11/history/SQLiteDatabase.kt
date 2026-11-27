package android.database.sqlite

import android.database.Cursor
import java.sql.Connection

class SQLiteDatabase(private val connection: Connection) {
    fun inTransaction() = !connection.autoCommit
    fun rawQuery(sql:String, args:Array<String>):Cursor {
        val query = connection.prepareStatement(sql)
        args.forEachIndexed { i, arg -> query.setString(i+1,arg) }
        return Cursor(query,query.executeQuery())
    }
}
