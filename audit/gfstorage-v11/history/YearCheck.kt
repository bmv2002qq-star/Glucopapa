package org.glukopapa.v3.m00

import android.database.sqlite.SQLiteDatabase
import java.sql.DriverManager
import java.time.Instant

fun main(args:Array<String>) {
    DriverManager.getConnection("jdbc:sqlite:"+args.single()).use { conn ->
        conn.autoCommit=false
        val db=SQLiteDatabase(conn)
        val end=Instant.parse("2024-10-27T01:30:00Z")
        val base=GfV3YearHistory.Stamp("GFMainCGM","graph","cgm","audit",1,1,0,"Europe/Warsaw",end)
        val cases=mapOf("graph" to listOf("cgm","forecasts"),"journal" to listOf("events","mealSessions","mealHistory","conditionPeriods","conditionHistory","mealTiming","corrections"),"settings" to listOf("settingHistory","coefficients","coefficientHistory","measurements","coefficientProposals"),"syncInbox" to listOf("syncInbox"))
        for((role,domains) in cases) for(domain in domains) {
            val stamp=base.copy(domain=domain,role=role)
            val index=GfV3YearHistory.buildOrder(db,stamp,10){}
            check(GfV3YearHistory.readOrdered(db,index,0,1).nextOffset==null)
            check(GfV3YearHistory.read(db,GfV3YearHistory.Token(stamp),1).next==null)
        }
        fun insert(id:String, time:Instant, profile:String="audit"){
            conn.prepareStatement("INSERT INTO v3_cgm VALUES(?,?,?,6,?,'synthetic','ok','{}',1)").use { q ->
                q.setString(1,id);q.setString(2,profile);q.setString(3,time.toString());q.setString(4,id);q.executeUpdate()
            }
        }
        insert("z",end);insert("past",base.start.minusNanos(1));insert("start",base.start)
        insert("a",end);insert("future",end.plusNanos(1));insert("foreign",end,"other")
        val index=GfV3YearHistory.buildOrder(db,base,3){}
        check(index.scanned==5L)
        val ids=mutableListOf<String>()
        var offset=0L
        do {
            val page=GfV3YearHistory.readOrdered(db,index,offset,1)
            ids+=page.data.getJSONArray("rows").getJSONObject(0).getString("historyRecordId")
            offset=page.nextOffset?:break
        } while(true)
        check(ids==listOf("start","a","z"))
        check(runCatching{GfV3YearHistory.buildOrder(db,base,2){}}.exceptionOrNull()?.message=="YEAR_HISTORY_ORDER_RESOURCE_LIMIT")
        check(runCatching{GfV3YearHistory.validateScope("GFMainCGM","graph","syncInbox")}.exceptionOrNull() is SecurityException)
        conn.rollback()
        println("15 domains read and ordered; exact annual boundaries, stable ties, foreign profile, resource and role denial PASS")
    }
}
