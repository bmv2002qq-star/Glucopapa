package android.database

import java.sql.PreparedStatement
import java.sql.ResultSet

class Cursor(private val query: PreparedStatement, private val rows: ResultSet): AutoCloseable {
    companion object {
        const val FIELD_TYPE_NULL = 0
        const val FIELD_TYPE_INTEGER = 1
        const val FIELD_TYPE_FLOAT = 2
        const val FIELD_TYPE_STRING = 3
    }
    val columnCount get() = rows.metaData.columnCount
    fun moveToNext() = rows.next()
    fun getLong(i: Int) = rows.getLong(i+1)
    fun getDouble(i: Int) = rows.getDouble(i+1)
    fun getString(i: Int): String = rows.getString(i+1)
    fun getColumnName(i: Int): String = rows.metaData.getColumnLabel(i+1)
    fun getType(i: Int) = when(rows.getObject(i+1)) {
        null -> FIELD_TYPE_NULL
        is Float, is Double -> FIELD_TYPE_FLOAT
        is Number -> FIELD_TYPE_INTEGER
        is String -> FIELD_TYPE_STRING
        else -> error("unsupported SQLite column")
    }
    override fun close() {rows.close();query.close()}
}
