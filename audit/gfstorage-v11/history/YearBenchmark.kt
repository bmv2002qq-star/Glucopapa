package org.glukopapa.v3.m00

import android.database.sqlite.SQLiteDatabase
import java.lang.management.ManagementFactory
import java.sql.DriverManager
import java.time.Instant
import org.json.JSONObject

fun main(args:Array<String>) {
    val days=args[1].toInt()
    val start=Instant.parse("2024-01-01T00:00:00Z")
    DriverManager.getConnection("jdbc:sqlite:"+args[0]).use { conn ->
        conn.autoCommit=false
        conn.prepareStatement("INSERT INTO v3_cgm VALUES(?,?,?,6,'sensor','synthetic','ok','{}',1)").use { insert ->
            for(i in 0 until days*288) {
                insert.setString(1,"bench-$i");insert.setString(2,"audit")
                insert.setString(3,start.plusSeconds(i*300L).toString());insert.addBatch()
                if(i%500==499)insert.executeBatch()
            }
            insert.executeBatch()
        }
        conn.commit()
        val db=SQLiteDatabase(conn)
        val stamp=GfV3YearHistory.Stamp("GFMainCGM","graph","cgm","audit",1,1,0,"UTC",start.plusSeconds(days*86400L))
        val begin=System.nanoTime()
        val order=GfV3YearHistory.buildOrder(db,stamp,1_000_000){}
        val buildMs=(System.nanoTime()-begin)/1e6
        check(order.keys.size==days*288)
        val times=(0 until 120).map { i ->
            val offset=i.toLong()*(order.keys.size-100)/119
            val before=System.nanoTime()
            val result=GfV3YearHistory.readOrdered(db,order,offset,100)
            check(result.data.getJSONArray("rows").length()==100)
            (System.nanoTime()-before)/1e6
        }.sorted()
        println(JSONObject().put("days",days).put("rows",order.keys.size).put("indexBuildMs",buildMs)
            .put("p50PageMs",times[59]).put("p95PageMs",times[113]).put("p99PageMs",times[118])
            .put("heapUsedAtEndBytes",ManagementFactory.getMemoryMXBean().heapMemoryUsage.used))
    }
}
