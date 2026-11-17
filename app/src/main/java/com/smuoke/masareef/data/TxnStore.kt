package com.smuoke.masareef.data

import android.content.Context
import com.smuoke.masareef.model.Txn
import org.json.JSONArray
import java.io.File

/** تخزين العمليات في ملف JSON داخل التطبيق */
object TxnStore {

    private const val FILE_NAME = "txns.json"

    @Synchronized
    fun load(context: Context): MutableList<Txn> {
        val f = File(context.filesDir, FILE_NAME)
        if (!f.exists()) return mutableListOf()
        return try {
            val arr = JSONArray(f.readText())
            MutableList(arr.length()) { i -> Txn.fromJson(arr.getJSONObject(i)) }
        } catch (e: Exception) {
            mutableListOf()
        }
    }

    @Synchronized
    fun save(context: Context, txns: List<Txn>) {
        val arr = JSONArray()
        txns.forEach { arr.put(it.toJson()) }
        File(context.filesDir, FILE_NAME).writeText(arr.toString())
    }

    /** يضيف العمليات الجديدة فقط (بدون تكرار). يرجع عدد المضاف. */
    @Synchronized
    fun addIfNew(context: Context, newTxns: List<Txn>): Int {
        val txns = load(context)
        val existing = txns.map { it.id }.toHashSet()
        var added = 0
        for (t in newTxns) {
            if (t.id !in existing) {
                txns.add(t)
                existing.add(t.id)
                added++
            }
        }
        if (added > 0) {
            txns.sortByDescending { it.time }
            save(context, txns)
        }
        return added
    }

    @Synchronized
    fun delete(context: Context, id: String) {
        val txns = load(context)
        if (txns.removeAll { it.id == id }) save(context, txns)
    }
}
