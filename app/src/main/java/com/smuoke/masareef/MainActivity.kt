package com.smuoke.masareef

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import com.smuoke.masareef.data.Prefs
import com.smuoke.masareef.data.TxnStore
import com.smuoke.masareef.model.Source
import com.smuoke.masareef.model.Txn
import com.smuoke.masareef.model.TxnType
import com.smuoke.masareef.sms.SmsImporter
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

private val Teal = Color(0xFF00695C)
private val TealLight = Color(0xFFE0F2F1)
private val RedSoft = Color(0xFFC62828)
private val GreenSoft = Color(0xFF2E7D32)

class MainActivity : ComponentActivity() {

    private var hasSmsPermission by mutableStateOf(false)

    private val permissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
            hasSmsPermission = result[Manifest.permission.READ_SMS] == true
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        hasSmsPermission = ContextCompat.checkSelfPermission(
            this, Manifest.permission.READ_SMS
        ) == PackageManager.PERMISSION_GRANTED

        if (!hasSmsPermission) {
            permissionLauncher.launch(
                arrayOf(Manifest.permission.READ_SMS, Manifest.permission.RECEIVE_SMS)
            )
        }

        setContent {
            MaterialTheme(
                colorScheme = lightColorScheme(
                    primary = Teal,
                    primaryContainer = TealLight,
                    surface = Color.White
                )
            ) {
                CompositionLocalProvider(LocalLayoutDirection provides LayoutDirection.Rtl) {
                    MasareefScreen(hasSmsPermission) {
                        permissionLauncher.launch(
                            arrayOf(Manifest.permission.READ_SMS, Manifest.permission.RECEIVE_SMS)
                        )
                    }
                }
            }
        }
    }
}

private fun fmt(v: Double): String = String.format(Locale.US, "%,.2f", v)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MasareefScreen(hasPermission: Boolean, onRequestPermission: () -> Unit) {
    val context = androidx.compose.ui.platform.LocalContext.current
    val scope = rememberCoroutineScope()
    val snackbar = remember { SnackbarHostState() }

    var txns by remember { mutableStateOf(TxnStore.load(context)) }
    var showSettings by remember { mutableStateOf(false) }
    var txnToDelete by remember { mutableStateOf<Txn?>(null) }
    var importing by remember { mutableStateOf(false) }

    fun reload() {
        txns = TxnStore.load(context)
    }

    fun importNow() {
        if (!hasPermission) {
            onRequestPermission()
            return
        }
        importing = true
        scope.launch {
            val added = withContext(Dispatchers.IO) { SmsImporter.importInbox(context) }
            reload()
            importing = false
            snackbar.showSnackbar(
                if (added > 0) "تمت إضافة $added عملية جديدة من الرسائل"
                else "لا توجد عمليات جديدة"
            )
        }
    }

    // أول فتح مع وجود الصلاحية: استورد تلقائياً
    LaunchedEffect(hasPermission) {
        if (hasPermission && txns.isEmpty()) importNow()
    }

    // حساب الدورة الحالية
    val manualSalary = Prefs.getManualSalary(context)
    val salaryTxn = txns.filter { it.type == TxnType.SALARY }.maxByOrNull { it.time }
    val salary = if (manualSalary > 0) manualSalary else (salaryTxn?.amount ?: 0.0)
    val cycleStart = salaryTxn?.time ?: monthStart()
    val cycleTxns = txns.filter { it.time >= cycleStart }
    val spent = cycleTxns
        .filter { it.type == TxnType.EXPENSE && it.source == Source.WALLET }
        .sumOf { it.amount }
    val remaining = salary - spent
    val progress = if (salary > 0) (spent / salary).coerceIn(0.0, 1.0).toFloat() else 0f

    Scaffold(
        snackbarHost = { SnackbarHost(snackbar) },
        topBar = {
            TopAppBar(
                title = { Text("مصاريفي", fontWeight = FontWeight.Bold) },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = Teal,
                    titleContentColor = Color.White,
                    actionIconContentColor = Color.White
                ),
                actions = {
                    IconButton(onClick = { importNow() }, enabled = !importing) {
                        Icon(Icons.Default.Refresh, contentDescription = "تحديث")
                    }
                    IconButton(onClick = { showSettings = true }) {
                        Icon(Icons.Default.Settings, contentDescription = "الإعدادات")
                    }
                }
            )
        }
    ) { padding ->
        Column(
            Modifier
                .padding(padding)
                .fillMaxSize()
                .background(Color(0xFFF5F5F5))
        ) {
            if (!hasPermission) {
                PermissionBanner(onRequestPermission)
            }

            SummaryCard(salary, spent, remaining, progress, salaryTxn)

            Text(
                "العمليات",
                fontWeight = FontWeight.Bold,
                fontSize = 16.sp,
                modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 8.dp)
            )

            if (importing) {
                LinearProgressIndicator(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp))
            }

            if (cycleTxns.isEmpty()) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Text(
                        "لا توجد عمليات بعد.\nاضغط زر التحديث لاستيراد الرسائل.",
                        textAlign = TextAlign.Center,
                        color = Color.Gray
                    )
                }
            } else {
                LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
                    items(cycleTxns, key = { it.id }) { txn ->
                        TxnRow(txn) { txnToDelete = txn }
                    }
                }
            }
        }
    }

    if (showSettings) {
        SettingsDialog(
            onDismiss = { showSettings = false; reload() }
        )
    }

    txnToDelete?.let { txn ->
        AlertDialog(
            onDismissRequest = { txnToDelete = null },
            title = { Text("حذف العملية؟") },
            text = { Text("${txnLabel(txn)} بمبلغ ${fmt(txn.amount)} ر.س") },
            confirmButton = {
                TextButton(onClick = {
                    TxnStore.delete(context, txn.id)
                    txnToDelete = null
                    reload()
                }) { Text("حذف", color = RedSoft) }
            },
            dismissButton = {
                TextButton(onClick = { txnToDelete = null }) { Text("إلغاء") }
            }
        )
    }
}

private fun monthStart(): Long {
    val c = Calendar.getInstance()
    c.set(Calendar.DAY_OF_MONTH, 1)
    c.set(Calendar.HOUR_OF_DAY, 0)
    c.set(Calendar.MINUTE, 0)
    c.set(Calendar.SECOND, 0)
    c.set(Calendar.MILLISECOND, 0)
    return c.timeInMillis
}

private fun txnLabel(t: Txn): String = when (t.type) {
    TxnType.SALARY -> "راتب"
    TxnType.EXPENSE -> t.merchant ?: "مصروف"
    TxnType.INCOME -> "وارد"
}

@Composable
private fun PermissionBanner(onRequest: () -> Unit) {
    Card(
        Modifier.fillMaxWidth().padding(16.dp),
        colors = CardDefaults.cardColors(containerColor = Color(0xFFFFF3E0))
    ) {
        Column(Modifier.padding(16.dp)) {
            Text("يحتاج التطبيق صلاحية قراءة الرسائل ليحسب مصروفاتك تلقائياً", fontSize = 14.sp)
            Spacer(Modifier.height(8.dp))
            Button(onClick = onRequest) { Text("منح الصلاحية") }
        }
    }
}

@Composable
private fun SummaryCard(
    salary: Double,
    spent: Double,
    remaining: Double,
    progress: Float,
    salaryTxn: Txn?
) {
    Card(
        Modifier.fillMaxWidth().padding(16.dp),
        shape = RoundedCornerShape(20.dp),
        colors = CardDefaults.cardColors(containerColor = Teal)
    ) {
        Column(Modifier.padding(20.dp)) {
            Text("المتبقي من الراتب", color = Color.White.copy(alpha = 0.8f), fontSize = 14.sp)
            Text(
                "${fmt(remaining)} ر.س",
                color = Color.White,
                fontSize = 32.sp,
                fontWeight = FontWeight.Bold
            )
            Spacer(Modifier.height(12.dp))
            LinearProgressIndicator(
                progress = { progress },
                modifier = Modifier.fillMaxWidth().height(8.dp),
                color = if (progress > 0.85f) Color(0xFFFF8A65) else Color(0xFF80CBC4),
                trackColor = Color.White.copy(alpha = 0.25f)
            )
            Spacer(Modifier.height(16.dp))
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Column {
                    Text("الراتب", color = Color.White.copy(alpha = 0.8f), fontSize = 12.sp)
                    Text(
                        if (salary > 0) "${fmt(salary)} ر.س" else "غير محدد",
                        color = Color.White, fontWeight = FontWeight.SemiBold
                    )
                }
                Column(horizontalAlignment = Alignment.End) {
                    Text("المصروف", color = Color.White.copy(alpha = 0.8f), fontSize = 12.sp)
                    Text("${fmt(spent)} ر.س", color = Color.White, fontWeight = FontWeight.SemiBold)
                }
            }
            salaryTxn?.let {
                Spacer(Modifier.height(8.dp))
                val df = SimpleDateFormat("dd/MM/yyyy", Locale.US)
                Text(
                    "بداية الدورة: ${df.format(Date(it.time))} (رسالة الراتب من ${it.sender})",
                    color = Color.White.copy(alpha = 0.7f),
                    fontSize = 11.sp
                )
            }
        }
    }
}

@Composable
private fun TxnRow(txn: Txn, onClick: () -> Unit) {
    val (label, color, sign) = when (txn.type) {
        TxnType.SALARY -> Triple("راتب 💰", GreenSoft, "+")
        TxnType.INCOME -> Triple(txnLabel(txn), GreenSoft, "+")
        TxnType.EXPENSE -> Triple(txnLabel(txn), RedSoft, "-")
    }
    val df = SimpleDateFormat("dd/MM HH:mm", Locale.US)

    Card(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 4.dp)
            .clickable { onClick() },
        shape = RoundedCornerShape(12.dp),
        colors = CardDefaults.cardColors(containerColor = Color.White)
    ) {
        Row(
            Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column(Modifier.weight(1f)) {
                Text(label, fontWeight = FontWeight.SemiBold, fontSize = 15.sp)
                Text(
                    "${txn.sender} · ${df.format(Date(txn.time))}",
                    color = Color.Gray,
                    fontSize = 12.sp
                )
            }
            Text(
                "$sign${fmt(txn.amount)} ر.س",
                color = color,
                fontWeight = FontWeight.Bold,
                fontSize = 15.sp
            )
        }
    }
}

@Composable
private fun SettingsDialog(onDismiss: () -> Unit) {
    val context = androidx.compose.ui.platform.LocalContext.current
    var banks by remember { mutableStateOf(Prefs.getBankSenders(context).joinToString(", ")) }
    var wallets by remember { mutableStateOf(Prefs.getWalletSenders(context).joinToString(", ")) }
    var manualSalary by remember {
        mutableStateOf(Prefs.getManualSalary(context).takeIf { it > 0 }?.toString() ?: "")
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("الإعدادات") },
        text = {
            Column(Modifier.fillMaxWidth()) {
                OutlinedTextField(
                    value = manualSalary,
                    onValueChange = { manualSalary = it },
                    label = { Text("الراتب يدوياً (اختياري)") },
                    supportingText = { Text("اتركه فارغاً ليؤخذ من رسالة البنك") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = banks,
                    onValueChange = { banks = it },
                    label = { Text("مرسلو البنك (مفصولة بفاصلة)") },
                    modifier = Modifier.fillMaxWidth(),
                    minLines = 2, maxLines = 4
                )
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = wallets,
                    onValueChange = { wallets = it },
                    label = { Text("مرسلو المحفظة (مفصولة بفاصلة)") },
                    modifier = Modifier.fillMaxWidth(),
                    minLines = 2, maxLines = 4
                )
            }
        },
        confirmButton = {
            TextButton(onClick = {
                Prefs.setBankSenders(context, banks)
                Prefs.setWalletSenders(context, wallets)
                Prefs.setManualSalary(context, manualSalary.toDoubleOrNull() ?: 0.0)
                onDismiss()
            }) { Text("حفظ") }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("إلغاء") }
        }
    )
}
