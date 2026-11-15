package com.smuoke.masareef.sms

import android.content.Context
import android.net.Uri
import com.smuoke.masareef.data.TxnStore
import com.smuoke.masareef.model.Txn

/** يستورد الرسائل القديمة من صندوق الوارد ويحللها */
object SmsImporter {

    /**
     * يقرأ رسائل آخر [monthsBack] شهر ويحفظ العمليات المالية.
     * يرجع عدد العمليات الجديدة المضافة.
     */
    fun importInbox(context: Context, monthsBack: Int = 6): Int {
        val since = System.currentTimeMillis() - monthsBack * 30L * 24 * 60 * 60 * 1000
        val uri = Uri.parse("content://sms/inbox")
        val found = mutableListOf<Txn>()

        context.contentResolver.query(
            uri,
            arrayOf("address", "body", "date"),
            "date >= ?",
            arrayOf(since.toString()),
            "date DESC"
        )?.use { c ->
            val iAddr = c.getColumnIndex("address")
            val iBody = c.getColumnIndex("body")
            val iDate = c.getColumnIndex("date")
            while (c.moveToNext()) {
                val sender = c.getString(iAddr) ?: continue
                val body = c.getString(iBody) ?: continue
                val time = c.getLong(iDate)
                SmsParser.parse(context, sender, body, time)?.let { found.add(it) }
            }
        }

        return TxnStore.addIfNew(context, found)
    }
}
