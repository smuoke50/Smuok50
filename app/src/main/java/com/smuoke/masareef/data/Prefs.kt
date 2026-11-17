package com.smuoke.masareef.data

import android.content.Context
import android.content.SharedPreferences
import com.smuoke.masareef.model.Source

/** إعدادات التطبيق: أسماء مرسلي البنك والمحفظة + راتب يدوي اختياري */
object Prefs {

    private const val NAME = "masareef_prefs"
    private const val KEY_BANKS = "bank_senders"
    private const val KEY_WALLETS = "wallet_senders"
    private const val KEY_MANUAL_SALARY = "manual_salary"

    val DEFAULT_BANKS = listOf(
        "alrajhi", "الراجحي", "snb", "alahli", "الأهلي", "الاهلي",
        "riyadbank", "الرياض", "alinma", "الإنماء", "الانماء",
        "sab", "ساب", "albilad", "البلاد", "anb", "العربي",
        "bsf", "الفرنسي", "aljazira", "الجزيرة", "gib", "d360"
    )

    val DEFAULT_WALLETS = listOf(
        "stc pay", "stcpay", "urpay", "barq", "برق", "tiqmo",
        "mobilypay", "mobily pay", "enjaz", "انجاز", "tweeq",
        "loop", "friendi", "محفظة"
    )

    private fun sp(context: Context): SharedPreferences =
        context.getSharedPreferences(NAME, Context.MODE_PRIVATE)

    fun getBankSenders(context: Context): List<String> =
        sp(context).getString(KEY_BANKS, null)
            ?.split(",")?.map { it.trim() }?.filter { it.isNotEmpty() }
            ?: DEFAULT_BANKS

    fun getWalletSenders(context: Context): List<String> =
        sp(context).getString(KEY_WALLETS, null)
            ?.split(",")?.map { it.trim() }?.filter { it.isNotEmpty() }
            ?: DEFAULT_WALLETS

    fun setBankSenders(context: Context, csv: String) {
        sp(context).edit().putString(KEY_BANKS, csv).apply()
    }

    fun setWalletSenders(context: Context, csv: String) {
        sp(context).edit().putString(KEY_WALLETS, csv).apply()
    }

    fun getManualSalary(context: Context): Double =
        sp(context).getString(KEY_MANUAL_SALARY, null)?.toDoubleOrNull() ?: 0.0

    fun setManualSalary(context: Context, value: Double) {
        sp(context).edit().putString(KEY_MANUAL_SALARY, value.toString()).apply()
    }

    /** يصنف اسم المرسل: بنك أو محفظة أو غير معروف */
    fun classify(context: Context, sender: String): Source {
        val s = sender.lowercase().replace(" ", "").replace("-", "")
        for (w in getWalletSenders(context)) {
            val key = w.lowercase().replace(" ", "").replace("-", "")
            if (key.isNotEmpty() && s.contains(key)) return Source.WALLET
        }
        for (b in getBankSenders(context)) {
            val key = b.lowercase().replace(" ", "").replace("-", "")
            if (key.isNotEmpty() && s.contains(key)) return Source.BANK
        }
        return Source.OTHER
    }
}
