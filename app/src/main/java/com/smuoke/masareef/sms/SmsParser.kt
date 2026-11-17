package com.smuoke.masareef.sms

import android.content.Context
import com.smuoke.masareef.data.Prefs
import com.smuoke.masareef.model.Source
import com.smuoke.masareef.model.Txn
import com.smuoke.masareef.model.TxnType
import java.security.MessageDigest

/**
 * محلل رسائل البنوك والمحافظ السعودية.
 *
 * القاعدة الأساسية حسب طلب المستخدم:
 *  - الراتب يُؤخذ من رسالة البنك (كلمة "راتب").
 *  - المصروفات تُحسب فقط من رسائل المحفظة (شراء / خصم / دفع ...).
 *  - تحويل الراتب من البنك للمحفظة لا يُحسب مصروفاً.
 */
object SmsParser {

    private val SALARY_KEYWORDS = listOf("راتب", "salary")

    private val EXPENSE_KEYWORDS = listOf(
        "شراء", "خصم", "تم خصم", "دفع", "سداد", "مدفوعات", "سحب",
        "حوالة صادرة", "تحويل صادر", "تحويل الى", "تحويل إلى",
        "pos", "purchase", "payment", "paid", "debit", "withdraw", "transfer to"
    )

    private val INCOME_KEYWORDS = listOf(
        "إيداع", "ايداع", "استلام", "حوالة واردة", "تحويل وارد",
        "اضافة", "إضافة", "استرداد", "شحن محفظة",
        "received", "credit", "deposit", "refund", "top up", "topup"
    )

    private val AMOUNT_PATTERNS = listOf(
        // SAR 1,234.56 / ر.س 500 / مبلغ: 120.5 / بمبلغ 70
        Regex("""(?:SAR|ر\.?\s?س|ريال|مبلغ|بمبلغ)\s*[:：]?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)""", RegexOption.IGNORE_CASE),
        // 1,234.56 SAR / 500 ريال
        Regex("""([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*(?:SAR|ر\.?\s?س|ريال)""", RegexOption.IGNORE_CASE)
    )

    private val MERCHANT_PATTERNS = listOf(
        Regex("""لدى\s*[:：]?\s*(.+)"""),
        Regex("""(?:عند|من متجر)\s*[:：]?\s*(.+)"""),
        Regex("""\bat[:\s]+(.+)""", RegexOption.IGNORE_CASE)
    )

    /** تحويل الأرقام العربية الهندية إلى أرقام غربية */
    private fun normalizeDigits(s: String): String {
        val sb = StringBuilder(s.length)
        for (c in s) {
            sb.append(
                when (c) {
                    in '٠'..'٩' -> ('0' + (c - '٠'))   // ٠-٩
                    in '۰'..'۹' -> ('0' + (c - '۰'))   // ۰-۹
                    '٫' -> '.'  // فاصلة عشرية عربية
                    '٬' -> ','  // فاصل آلاف عربي
                    else -> c
                }
            )
        }
        return sb.toString()
    }

    fun extractAmount(body: String): Double? {
        val text = normalizeDigits(body)
        for (p in AMOUNT_PATTERNS) {
            val m = p.find(text) ?: continue
            val raw = m.groupValues[1].replace(",", "")
            val v = raw.toDoubleOrNull()
            if (v != null && v > 0) return v
        }
        return null
    }

    private fun extractMerchant(body: String): String? {
        for (p in MERCHANT_PATTERNS) {
            val m = p.find(body) ?: continue
            val merchant = m.groupValues[1].lineSequence().firstOrNull()?.trim()
                ?.trimEnd('.', '،', ',')
            if (!merchant.isNullOrBlank()) return merchant.take(40)
        }
        return null
    }

    private fun containsAny(text: String, keywords: List<String>): Boolean {
        val t = text.lowercase()
        return keywords.any { t.contains(it) }
    }

    private fun makeId(sender: String, body: String, time: Long): String {
        // نفس الرسالة = نفس المعرف، حتى لا تتكرر بين الاستقبال المباشر والاستيراد
        val bucket = time / 120000 // نافذة دقيقتين
        val md = MessageDigest.getInstance("MD5")
            .digest("$sender|$body|$bucket".toByteArray())
        return md.joinToString("") { "%02x".format(it) }
    }

    /**
     * يحلل رسالة واحدة ويرجع عملية إن كانت مالية، أو null.
     */
    fun parse(context: Context, sender: String, body: String, time: Long): Txn? {
        val source = Prefs.classify(context, sender)
        if (source == Source.OTHER) return null

        val amount = extractAmount(body) ?: return null

        val type: TxnType = when {
            // الراتب: من رسائل البنك فقط
            source == Source.BANK && containsAny(body, SALARY_KEYWORDS) -> TxnType.SALARY
            // وارد (إيداع/استلام) — لا يُحسب مصروفاً
            containsAny(body, INCOME_KEYWORDS) && !containsAny(body, EXPENSE_KEYWORDS) -> TxnType.INCOME
            // مصروف
            containsAny(body, EXPENSE_KEYWORDS) -> TxnType.EXPENSE
            else -> return null
        }

        // رسائل البنك: نهتم فقط بالراتب (التحويل للمحفظة ليس مصروفاً)
        if (source == Source.BANK && type != TxnType.SALARY) return null

        return Txn(
            id = makeId(sender, body, time),
            time = time,
            sender = sender,
            body = body,
            amount = amount,
            type = type,
            source = source,
            merchant = extractMerchant(body)
        )
    }
}
