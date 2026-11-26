import CoreBluetooth
import Foundation

/// CoreBluetooth side of window.FahisNative. Events go back to JS as calls on
/// window.FahisNativeEvents (devices / connected / data / error / disconnected).
/// iOS exposes no MAC addresses: a peripheral's identifier UUID plays the role of "address".
final class BLEBridge: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {
    private static let knownServices: [CBUUID] = [
        CBUUID(string: "FFF0"), // common clones: FFF1 notify / FFF2 write
        CBUUID(string: "FFE0"), // HM-10 style
        CBUUID(string: "18F0"), // vLinker / iCar Pro
        CBUUID(string: "E7810A71-73AE-499D-8C15-FAA9AEF0C3F2"), // OBDLink CX, Veepeak BLE+
    ]

    private let evalJS: (String) -> Void
    private var central: CBCentralManager?
    private var whenReady: [() -> Void] = []

    private var found: [UUID: CBPeripheral] = [:]
    private var names: [UUID: String] = [:]
    private var scanning = false

    private var peripheral: CBPeripheral?
    private var rx: CBCharacteristic?
    private var tx: CBCharacteristic?
    private var ready = false
    private var pendingServices = 0
    private var queue: [Data] = []
    private var writeInFlight = false

    init(evalJS: @escaping (String) -> Void) {
        self.evalJS = evalJS
    }

    // MARK: - JS events

    private func event(_ name: String, _ arg: String? = nil) {
        var js = "window.FahisNativeEvents && FahisNativeEvents.\(name) && FahisNativeEvents.\(name)("
        if let arg = arg,
           let data = try? JSONSerialization.data(withJSONObject: arg, options: .fragmentsAllowed),
           let quoted = String(data: data, encoding: .utf8) {
            js += quoted
        }
        js += ")"
        DispatchQueue.main.async { self.evalJS(js) }
    }

    // MARK: - Bluetooth state

    /// Runs `action` once Bluetooth is powered on; the first call triggers the permission prompt.
    private func whenPoweredOn(_ action: @escaping () -> Void) {
        guard let central = central else {
            whenReady.append(action)
            self.central = CBCentralManager(delegate: self, queue: nil)
            return
        }
        switch central.state {
        case .poweredOn: action()
        case .unknown, .resetting: whenReady.append(action)
        default: reportState(central.state)
        }
    }

    private func reportState(_ state: CBManagerState) {
        switch state {
        case .unauthorized: event("error", "اسمح لفاحص باستخدام البلوتوث من الإعدادات ← فاحص.")
        case .poweredOff: event("error", "شغّل البلوتوث من مركز التحكم ثم حاول مرة أخرى.")
        case .unsupported: event("error", "هذا الجهاز لا يدعم بلوتوث BLE.")
        default: break
        }
    }

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        if central.state == .poweredOn {
            let actions = whenReady
            whenReady.removeAll()
            actions.forEach { $0() }
        } else if central.state != .unknown && central.state != .resetting {
            whenReady.removeAll()
            reportState(central.state)
            if ready { cleanup(); event("disconnected") }
        }
    }

    // MARK: - Scan

    func scan() {
        whenPoweredOn { [weak self] in
            guard let self = self, let central = self.central, !self.scanning else { return }
            self.scanning = true
            self.found.removeAll()
            self.names.removeAll()
            // Already-connected OBD peripherals (e.g. held by another app) do not advertise.
            for p in central.retrieveConnectedPeripherals(withServices: Self.knownServices) {
                self.found[p.identifier] = p
                self.names[p.identifier] = p.name ?? "OBD"
            }
            central.scanForPeripherals(withServices: nil, options: [CBCentralManagerScanOptionAllowDuplicatesKey: false])
            DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
                guard let self = self else { return }
                central.stopScan()
                self.scanning = false
                let list: [[String: Any]] = self.found.keys.map { id in
                    ["name": self.names[id] ?? id.uuidString, "address": id.uuidString, "kind": "ble", "paired": false]
                }
                if let data = try? JSONSerialization.data(withJSONObject: list),
                   let json = String(data: data, encoding: .utf8) {
                    self.event("devices", json)
                }
            }
        }
    }

    func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
                        advertisementData: [String: Any], rssi RSSI: NSNumber) {
        let advName = advertisementData[CBAdvertisementDataLocalNameKey] as? String
        guard let name = advName ?? peripheral.name, !name.isEmpty else { return }
        found[peripheral.identifier] = peripheral
        names[peripheral.identifier] = name
    }

    // MARK: - Connect

    func connect(identifier: String) {
        whenPoweredOn { [weak self] in
            guard let self = self, let central = self.central else { return }
            guard let id = UUID(uuidString: identifier),
                  let p = self.found[id] ?? central.retrievePeripherals(withIdentifiers: [id]).first else {
                self.event("error", "لم يُعثر على المحوّل. ابحث مرة أخرى.")
                return
            }
            self.disconnect()
            self.peripheral = p
            p.delegate = self
            central.connect(p, options: nil)
            // CoreBluetooth never times out a connect on its own.
            DispatchQueue.main.asyncAfter(deadline: .now() + 15) { [weak self] in
                guard let self = self, self.peripheral === p, !self.ready else { return }
                central.cancelPeripheralConnection(p)
                self.cleanup()
                self.event("error", "انتهت مهلة الاتصال. تأكد أن المحوّل مركّب والسيارة على وضع التشغيل.")
            }
        }
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        peripheral.discoverServices(Self.knownServices)
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        guard peripheral === self.peripheral else { return }
        cleanup()
        event("error", "تعذّر الاتصال بالمحوّل.")
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        guard peripheral === self.peripheral else { return }
        let wasReady = ready
        cleanup()
        if wasReady { event("disconnected") } else { event("error", "انقطع الاتصال قبل اكتماله.") }
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        let services = peripheral.services ?? []
        guard !services.isEmpty else {
            failSetup(peripheral, "هذا المحوّل لا يعرض خدمة OBD معروفة.")
            return
        }
        pendingServices = services.count
        services.forEach { peripheral.discoverCharacteristics(nil, for: $0) }
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        pendingServices -= 1
        if rx == nil || tx == nil {
            let chars = service.characteristics ?? []
            let notify = chars.first { $0.properties.contains(.notify) || $0.properties.contains(.indicate) }
            let write = chars.first { $0.properties.contains(.writeWithoutResponse) }
                ?? chars.first { $0.properties.contains(.write) }
            if let notify = notify, let write = write {
                rx = notify
                tx = write
                peripheral.setNotifyValue(true, for: notify)
                return
            }
        }
        if pendingServices == 0 && (rx == nil || tx == nil) {
            failSetup(peripheral, "هذا المحوّل لا يعرض خدمة OBD معروفة.")
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
        guard characteristic === rx else { return }
        if characteristic.isNotifying {
            ready = true
            event("connected", peripheral.name ?? "OBD")
        } else {
            failSetup(peripheral, "تعذّر تفعيل استقبال البيانات من المحوّل.")
        }
    }

    private func failSetup(_ p: CBPeripheral, _ message: String) {
        central?.cancelPeripheralConnection(p)
        cleanup()
        event("error", message)
    }

    // MARK: - I/O

    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        guard characteristic === rx, let data = characteristic.value, !data.isEmpty else { return }
        event("data", String(decoding: data, as: UTF8.self))
    }

    func write(_ string: String) {
        guard ready, let p = peripheral, let tx = tx, let data = string.data(using: .ascii, allowLossyConversion: true) else { return }
        let type: CBCharacteristicWriteType = tx.properties.contains(.writeWithoutResponse) ? .withoutResponse : .withResponse
        let chunk = max(20, p.maximumWriteValueLength(for: type))
        var offset = 0
        while offset < data.count {
            let end = min(offset + chunk, data.count)
            queue.append(data.subdata(in: offset..<end))
            offset = end
        }
        pump()
    }

    private func pump() {
        guard let p = peripheral, let tx = tx else { return }
        if tx.properties.contains(.writeWithoutResponse) {
            while !queue.isEmpty && p.canSendWriteWithoutResponse {
                p.writeValue(queue.removeFirst(), for: tx, type: .withoutResponse)
            }
        } else if !writeInFlight, !queue.isEmpty {
            writeInFlight = true
            p.writeValue(queue.removeFirst(), for: tx, type: .withResponse)
        }
    }

    func peripheralIsReady(toSendWriteWithoutResponse peripheral: CBPeripheral) {
        pump()
    }

    func peripheral(_ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
        writeInFlight = false
        pump()
    }

    func disconnect() {
        if let p = peripheral { central?.cancelPeripheralConnection(p) }
        cleanup()
    }

    private func cleanup() {
        peripheral?.delegate = nil
        peripheral = nil
        rx = nil
        tx = nil
        ready = false
        pendingServices = 0
        queue.removeAll()
        writeInFlight = false
    }
}
