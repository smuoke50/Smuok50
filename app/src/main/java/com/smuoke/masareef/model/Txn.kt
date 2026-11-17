package com.smuoke.masareef.model

import org.json.JSONObject

/** نوع العملية */
enum class TxnType { SALARY, EXPENSE, INCOME }

/** مصدر الرسالة: بنك أو محفظة */
enum class Source { BANK, WALLET, OTHER }

data class Txn(
    val id: String,
    val time: Long,
    val sender: String,
    val body: String,
    val amount: Double,
    val type: TxnType,
    val source: Source,
    val merchant: String?
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("id", id)
        put("time", time)
        put("sender", sender)
        put("body", body)
        put("amount", amount)
        put("type", type.name)
        put("source", source.name)
        put("merchant", merchant ?: JSONObject.NULL)
    }

    companion object {
        fun fromJson(o: JSONObject): Txn = Txn(
            id = o.getString("id"),
            time = o.getLong("time"),
            sender = o.getString("sender"),
            body = o.getString("body"),
            amount = o.getDouble("amount"),
            type = TxnType.valueOf(o.getString("type")),
            source = Source.valueOf(o.getString("source")),
            merchant = if (o.isNull("merchant")) null else o.getString("merchant")
        )
    }
}
