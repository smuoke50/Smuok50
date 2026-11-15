package com.smuoke.masareef.sms

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony
import com.smuoke.masareef.data.TxnStore

/** يستقبل الرسائل الجديدة لحظياً ويسجل العمليات المالية تلقائياً */
class SmsReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return

        val messages = Telephony.Sms.Intents.getMessagesFromIntent(intent) ?: return

        // الرسالة الطويلة تصل مقسمة؛ نجمع الأجزاء حسب المرسل
        val grouped = messages.filterNotNull().groupBy { it.displayOriginatingAddress ?: "" }
        for ((sender, parts) in grouped) {
            if (sender.isEmpty()) continue
            val body = parts.joinToString("") { it.messageBody ?: "" }
            val time = parts.first().timestampMillis
            val txn = SmsParser.parse(context, sender, body, time) ?: continue
            TxnStore.addIfNew(context, listOf(txn))
        }
    }
}
