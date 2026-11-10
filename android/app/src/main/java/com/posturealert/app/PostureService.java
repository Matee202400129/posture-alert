package com.posturealert.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.bluetooth.BluetoothStatusCodes;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanFilter;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.ParcelUuid;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;
import android.os.SystemClock;
import android.util.Log;

import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.UUID;

/**
 * Foreground service that owns the Bluetooth link to the PostureAlert board.
 * Keeps running with the screen off, shows the live posture in an ongoing notification,
 * and alerts on the phone (notification and/or vibration) when the board starts its alarm.
 * All Bluetooth callbacks are moved onto the main thread, so the state needs no locking.
 */
@SuppressLint("MissingPermission") // MainActivity checks the permissions before starting this service
public class PostureService extends Service {
    private static final String TAG = "PostureService";
    static final String ACTION_CONNECT = "com.posturealert.app.CONNECT";
    static final String ACTION_DISCONNECT = "com.posturealert.app.DISCONNECT";
    static final String DEVICE_NAME = "PostureAlert";
    static final UUID SERVICE_UUID = UUID.fromString("6e1f0001-5b8a-4c2b-9d3e-7a1c2f4e8b10");
    static final UUID STATUS_UUID = UUID.fromString("6e1f0002-5b8a-4c2b-9d3e-7a1c2f4e8b10");
    static final UUID COMMAND_UUID = UUID.fromString("6e1f0003-5b8a-4c2b-9d3e-7a1c2f4e8b10");
    static final UUID CCCD_UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");

    static final String PREFS = "posture";
    static final String PREF_VIBRATE = "vibrate";
    static final String PREF_NOTIFY = "notify";

    private static final String CHANNEL_STATUS = "status";
    private static final String CHANNEL_ALERT = "alert";
    private static final int NOTE_STATUS = 1;
    private static final int NOTE_ALERT = 2;
    private static final long SCAN_TIMEOUT_MS = 12_000;
    private static final long CONNECT_TIMEOUT_MS = 15_000;
    private static final long WRITE_TIMEOUT_MS = 3_000;
    private static final long NOTE_MIN_GAP_MS = 2_000;
    private static final int FIRST_CONNECT_TRIES = 3;
    private static final long[] ALERT_VIBRATION = {0, 400, 200, 400};

    /** What the web page wants to hear about. Called on the main thread. */
    interface Listener {
        void onStatus(String status, int attempt);
        void onError(String name, String message);
        void onPacket(byte[] data);
        void onReply(int id, boolean ok, String message);
    }

    private static PostureService instance;
    private static Listener listener;

    private final Handler main = new Handler(Looper.getMainLooper());
    private final ArrayDeque<Command> commands = new ArrayDeque<>();
    private BluetoothAdapter adapter;
    private BluetoothLeScanner scanner;
    private BluetoothDevice device;
    private BluetoothGatt gatt;
    private BluetoothGattCharacteristic statusChar;
    private BluetoothGattCharacteristic commandChar;
    private NotificationManager notes;
    private SharedPreferences prefs;

    private String status = "idle";
    private int attempt;
    private int firstTries;
    private boolean want;
    private boolean everConnected;
    private boolean scanning;
    private boolean prevAlarm;
    private byte[] lastPacket;
    private String lastNoteText = "";
    private long lastNoteAt;
    private Command writing;

    private static final class Command {
        final int id;
        final String text;
        final boolean powerOff;

        Command(int id, String text, boolean powerOff) {
            this.id = id;
            this.text = text;
            this.powerOff = powerOff;
        }
    }

    // ---------- Called from MainActivity ----------

    static void setListener(Listener l) {
        listener = l;
    }

    /** The page loaded (or came back): tell it whether we are already connected. */
    static void hello() {
        if (listener == null) return;
        if (instance == null) {
            listener.onStatus("idle", 0);
            return;
        }
        listener.onStatus(instance.status, instance.attempt);
        if ("connected".equals(instance.status) && instance.lastPacket != null) listener.onPacket(instance.lastPacket);
    }

    static void send(int id, String text) {
        if (instance == null) {
            if (listener != null) listener.onReply(id, false, "not connected");
            return;
        }
        instance.enqueue(new Command(id, text, false));
    }

    static void powerOff(int id) {
        if (instance == null) {
            if (listener != null) listener.onReply(id, false, "not connected");
            return;
        }
        instance.enqueue(new Command(id, "off", true));
    }

    static void disconnect(Context ctx) {
        if (instance != null) instance.stopByUser();
        else if (listener != null) listener.onStatus("idle", 0);
    }

    // ---------- Service lifecycle ----------

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        notes = getSystemService(NotificationManager.class);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        BluetoothManager manager = getSystemService(BluetoothManager.class);
        adapter = manager != null ? manager.getAdapter() : null;
        createChannels();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        // Android requires startForeground soon after startForegroundService, whatever happens next
        goForeground(want && !lastNoteText.isEmpty() ? lastNoteText : getString(R.string.searching));
        if (ACTION_DISCONNECT.equals(action)) {
            stopByUser();
        } else if (!want) {
            begin();
        } else {
            hello();
        }
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        main.removeCallbacksAndMessages(null);
        stopScan();
        closeGatt();
        instance = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    // ---------- Connecting ----------

    private void begin() {
        if (adapter == null) {
            fail("NotSupportedError", "no bluetooth");
            return;
        }
        if (!adapter.isEnabled()) {
            fail("BluetoothOff", "bluetooth is off");
            return;
        }
        if (!hasPermissions(this)) {
            fail("PermissionError", "missing permission");
            return;
        }
        want = true;
        everConnected = false;
        firstTries = 0;
        attempt = 0;
        setStatus("connecting");
        startScan();
    }

    static boolean hasPermissions(Context ctx) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            return granted(ctx, Manifest.permission.BLUETOOTH_SCAN) && granted(ctx, Manifest.permission.BLUETOOTH_CONNECT);
        }
        return granted(ctx, Manifest.permission.ACCESS_FINE_LOCATION);
    }

    private static boolean granted(Context ctx, String permission) {
        return ctx.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED;
    }

    private void startScan() {
        scanner = adapter.getBluetoothLeScanner();
        if (scanner == null) {
            fail("BluetoothOff", "scanner unavailable");
            return;
        }
        // Either filter matches: the firmware advertises the service UUID, and the name in the scan response
        List<ScanFilter> filters = new ArrayList<>();
        filters.add(new ScanFilter.Builder().setServiceUuid(new ParcelUuid(SERVICE_UUID)).build());
        filters.add(new ScanFilter.Builder().setDeviceName(DEVICE_NAME).build());
        ScanSettings settings = new ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build();
        scanning = true;
        scanner.startScan(filters, settings, scanCallback);
        main.postDelayed(scanTimeout, SCAN_TIMEOUT_MS);
    }

    private final Runnable scanTimeout = () -> {
        if (!scanning) return;
        stopScan();
        fail("NotFoundError", "no PostureAlert nearby");
    };

    private void stopScan() {
        main.removeCallbacks(scanTimeout);
        if (!scanning) return;
        scanning = false;
        try {
            if (scanner != null && adapter.isEnabled()) scanner.stopScan(scanCallback);
        } catch (IllegalStateException e) {
            Log.w(TAG, "stopScan", e);
        }
    }

    private final ScanCallback scanCallback = new ScanCallback() {
        @Override
        public void onScanResult(int callbackType, ScanResult result) {
            main.post(() -> {
                if (!scanning || !want) return;
                stopScan();
                device = result.getDevice();
                connectGatt(false);
            });
        }

        @Override
        public void onScanFailed(int errorCode) {
            main.post(() -> {
                scanning = false;
                fail("NetworkError", "scan failed " + errorCode);
            });
        }
    };

    /** autoConnect=false connects fast for the first time; true waits quietly for the board to come back. */
    private void connectGatt(boolean autoConnect) {
        closeGatt();
        gatt = device.connectGatt(this, autoConnect, gattCallback, BluetoothDevice.TRANSPORT_LE);
        if (!autoConnect) main.postDelayed(connectTimeout, CONNECT_TIMEOUT_MS);
    }

    private final Runnable connectTimeout = () -> {
        if (!"connected".equals(status)) handleDisconnect(BluetoothGatt.GATT_FAILURE);
    };

    private void closeGatt() {
        main.removeCallbacks(connectTimeout);
        if (gatt != null) {
            try {
                gatt.close();
            } catch (Exception e) {
                Log.w(TAG, "close", e);
            }
        }
        gatt = null;
        statusChar = null;
        commandChar = null;
    }

    private final BluetoothGattCallback gattCallback = new BluetoothGattCallback() {
        @Override
        public void onConnectionStateChange(BluetoothGatt g, int gattStatus, int newState) {
            main.post(() -> {
                if (g != gatt) return;
                if (newState == BluetoothProfile.STATE_CONNECTED && gattStatus == BluetoothGatt.GATT_SUCCESS) {
                    g.discoverServices();
                } else if (newState == BluetoothProfile.STATE_DISCONNECTED || gattStatus != BluetoothGatt.GATT_SUCCESS) {
                    handleDisconnect(gattStatus);
                }
            });
        }

        @Override
        public void onServicesDiscovered(BluetoothGatt g, int gattStatus) {
            main.post(() -> {
                if (g != gatt) return;
                BluetoothGattService svc = g.getService(SERVICE_UUID);
                statusChar = svc != null ? svc.getCharacteristic(STATUS_UUID) : null;
                commandChar = svc != null ? svc.getCharacteristic(COMMAND_UUID) : null;
                if (statusChar == null || commandChar == null) {
                    want = false;
                    closeGatt();
                    fail("NotFoundError", "service or characteristic missing");
                    return;
                }
                g.setCharacteristicNotification(statusChar, true);
                BluetoothGattDescriptor cccd = statusChar.getDescriptor(CCCD_UUID);
                if (cccd == null || !writeDescriptor(g, cccd, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)) {
                    onReady(g);
                }
            });
        }

        @Override
        public void onDescriptorWrite(BluetoothGatt g, BluetoothGattDescriptor descriptor, int gattStatus) {
            main.post(() -> {
                if (g == gatt) onReady(g);
            });
        }

        @Override
        public void onCharacteristicRead(BluetoothGatt g, BluetoothGattCharacteristic c, byte[] value, int gattStatus) {
            byte[] copy = value.clone();
            main.post(() -> {
                if (g == gatt && gattStatus == BluetoothGatt.GATT_SUCCESS) handlePacket(copy);
            });
        }

        @Override
        @SuppressWarnings("deprecation")
        public void onCharacteristicRead(BluetoothGatt g, BluetoothGattCharacteristic c, int gattStatus) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) return;
            byte[] value = c.getValue();
            if (value != null) onCharacteristicRead(g, c, value, gattStatus);
        }

        @Override
        public void onCharacteristicChanged(BluetoothGatt g, BluetoothGattCharacteristic c, byte[] value) {
            byte[] copy = value.clone();
            main.post(() -> {
                if (g == gatt) handlePacket(copy);
            });
        }

        @Override
        @SuppressWarnings("deprecation")
        public void onCharacteristicChanged(BluetoothGatt g, BluetoothGattCharacteristic c) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) return;
            byte[] value = c.getValue();
            if (value != null) onCharacteristicChanged(g, c, value);
        }

        @Override
        public void onCharacteristicWrite(BluetoothGatt g, BluetoothGattCharacteristic c, int gattStatus) {
            main.post(() -> {
                if (g == gatt) finishWrite(gattStatus == BluetoothGatt.GATT_SUCCESS, "write status " + gattStatus);
            });
        }
    };

    @SuppressWarnings("deprecation")
    private static boolean writeDescriptor(BluetoothGatt g, BluetoothGattDescriptor d, byte[] value) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            return g.writeDescriptor(d, value) == BluetoothStatusCodes.SUCCESS;
        }
        d.setValue(value);
        return g.writeDescriptor(d);
    }

    /** Notifications are on: read once so the page has data straight away, then report connected. */
    private void onReady(BluetoothGatt g) {
        main.removeCallbacks(connectTimeout);
        everConnected = true;
        attempt = 0;
        firstTries = 0;
        setStatus("connected");
        g.readCharacteristic(statusChar);
        pumpCommands();
    }

    private void handleDisconnect(int gattStatus) {
        Log.i(TAG, "disconnected, status " + gattStatus + ", want " + want);
        failPendingCommands("disconnected");
        if (!want) {
            closeGatt();
            finish();
            return;
        }
        if (!everConnected) {
            // First connection: retry a couple of times like the web app does, then give up with an error
            firstTries++;
            if (firstTries < FIRST_CONNECT_TRIES && device != null) {
                main.postDelayed(() -> { if (want) connectGatt(false); }, 600);
            } else {
                closeGatt();
                fail("NetworkError", "could not connect (status " + gattStatus + ")");
            }
            return;
        }
        attempt++;
        setStatus("reconnecting");
        cancelAlert();
        prevAlarm = false;
        // autoConnect waits for the board to advertise again, using little battery
        connectGatt(true);
    }

    // ---------- Packets and alerts ----------

    private void handlePacket(byte[] value) {
        Packet p = Packet.parse(value);
        if (p == null) return;
        lastPacket = value;
        if (listener != null) listener.onPacket(value);
        updateStatusNote(p);
        if (p.alarm && !prevAlarm) alert(p);
        if (!p.alarm && prevAlarm) cancelAlert();
        prevAlarm = p.alarm;
    }

    private void alert(Packet p) {
        String text = String.format(Locale.US, "ยืดหลังให้ตรงขึ้น ตอนนี้โค้ง %.0f° (เกณฑ์ %d°)", p.curve, p.effectiveThreshold());
        if (prefs.getBoolean(PREF_NOTIFY, true)) {
            Notification n = new Notification.Builder(this, CHANNEL_ALERT)
                    .setSmallIcon(R.drawable.ic_stat)
                    .setContentTitle("หลังค่อมแล้ว")
                    .setContentText(text)
                    .setCategory(Notification.CATEGORY_REMINDER)
                    .setContentIntent(openAppIntent())
                    .setAutoCancel(true)
                    .build();
            notes.notify(NOTE_ALERT, n);
        }
        if (prefs.getBoolean(PREF_VIBRATE, true)) vibrate();
    }

    private void cancelAlert() {
        notes.cancel(NOTE_ALERT);
    }

    @SuppressWarnings("deprecation")
    private void vibrate() {
        Vibrator vibrator;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            VibratorManager vm = getSystemService(VibratorManager.class);
            vibrator = vm != null ? vm.getDefaultVibrator() : null;
        } else {
            vibrator = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
        }
        if (vibrator == null || !vibrator.hasVibrator()) return;
        // Alarm usage so the phone still buzzes with the screen off
        AudioAttributes attrs = new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).build();
        vibrator.vibrate(VibrationEffect.createWaveform(ALERT_VIBRATION, -1), attrs);
    }

    // ---------- Commands (one at a time, with the same gaps as the web app) ----------

    static long commandGapMs(String text) {
        switch (text) {
            case "cal": return 900;
            case "buzz": return 500;
            case "snooze": return 600;
            default: return 150;
        }
    }

    private void enqueue(Command c) {
        commands.add(c);
        pumpCommands();
    }

    private void pumpCommands() {
        if (writing != null || commands.isEmpty()) return;
        if (!"connected".equals(status) || gatt == null || commandChar == null) {
            failPendingCommands("not connected");
            return;
        }
        Command c = commands.poll();
        writing = c;
        if (!writeCommand(c.text.getBytes(StandardCharsets.UTF_8))) {
            finishWrite(false, "write rejected");
            return;
        }
        main.postDelayed(writeTimeout, WRITE_TIMEOUT_MS);
    }

    private final Runnable writeTimeout = () -> finishWrite(false, "write timed out");

    @SuppressWarnings("deprecation")
    private boolean writeCommand(byte[] value) {
        int type = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            return gatt.writeCharacteristic(commandChar, value, type) == BluetoothStatusCodes.SUCCESS;
        }
        commandChar.setValue(value);
        commandChar.setWriteType(type);
        return gatt.writeCharacteristic(commandChar);
    }

    private void finishWrite(boolean ok, String message) {
        main.removeCallbacks(writeTimeout);
        Command c = writing;
        if (c == null) return;
        if (listener != null) listener.onReply(c.id, ok, ok ? "" : message);
        if (ok && c.powerOff) {
            // The board goes to sleep and can only be woken by its button: stop trying to reconnect
            writing = null;
            stopByUser();
            return;
        }
        main.postDelayed(() -> {
            writing = null;
            pumpCommands();
        }, commandGapMs(c.text));
    }

    private void failPendingCommands(String message) {
        if (writing != null) {
            main.removeCallbacks(writeTimeout);
            if (listener != null) listener.onReply(writing.id, false, message);
            writing = null;
        }
        while (!commands.isEmpty()) {
            Command c = commands.poll();
            if (listener != null) listener.onReply(c.id, false, message);
        }
    }

    // ---------- Status and notifications ----------

    private void setStatus(String s) {
        status = s;
        if (listener != null) listener.onStatus(s, attempt);
        if ("reconnecting".equals(s)) {
            showStatusNote(String.format(Locale.US, "สัญญาณหลุด กำลังต่อใหม่ (ครั้งที่ %d)", attempt));
        } else if ("connecting".equals(s)) {
            showStatusNote(getString(R.string.searching));
        } else if ("connected".equals(s)) {
            showStatusNote("เชื่อมต่อแล้ว");
        }
    }

    private void fail(String name, String message) {
        Log.w(TAG, "fail " + name + ": " + message);
        want = false;
        status = "idle";
        if (listener != null) listener.onError(name, message);
        finish();
    }

    /** User pressed disconnect (or power off): close everything and leave quietly. */
    private void stopByUser() {
        want = false;
        stopScan();
        failPendingCommands("disconnected");
        if (gatt != null) {
            try {
                gatt.disconnect();
            } catch (Exception e) {
                Log.w(TAG, "disconnect", e);
            }
        }
        closeGatt();
        finish();
    }

    private void finish() {
        status = "idle";
        lastPacket = null;
        prevAlarm = false;
        cancelAlert();
        if (listener != null) listener.onStatus("idle", 0);
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    private void updateStatusNote(Packet p) {
        String text = p.summary();
        long now = SystemClock.elapsedRealtime();
        boolean stateChanged = !lastNoteText.startsWith(p.label());
        if (text.equals(lastNoteText) || (!stateChanged && now - lastNoteAt < NOTE_MIN_GAP_MS)) return;
        showStatusNote(text);
    }

    private void showStatusNote(String text) {
        lastNoteText = text;
        lastNoteAt = SystemClock.elapsedRealtime();
        notes.notify(NOTE_STATUS, buildStatusNote(text));
    }

    private Notification buildStatusNote(String text) {
        Intent stop = new Intent(this, PostureService.class).setAction(ACTION_DISCONNECT);
        PendingIntent stopIntent = PendingIntent.getService(this, 1, stop, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new Notification.Builder(this, CHANNEL_STATUS)
                .setSmallIcon(R.drawable.ic_stat)
                .setContentTitle("PostureAlert")
                .setContentText(text)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setShowWhen(false)
                .setContentIntent(openAppIntent())
                .addAction(new Notification.Action.Builder(null, "ตัดการเชื่อมต่อ", stopIntent).build())
                .build();
    }

    private void goForeground(String text) {
        Notification n = buildStatusNote(text);
        lastNoteText = text;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTE_STATUS, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE);
        } else {
            startForeground(NOTE_STATUS, n);
        }
    }

    private PendingIntent openAppIntent() {
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private void createChannels() {
        NotificationChannel statusChannel = new NotificationChannel(CHANNEL_STATUS, "สถานะท่านั่ง", NotificationManager.IMPORTANCE_LOW);
        statusChannel.setDescription("แสดงท่านั่งตอนนี้ระหว่างเชื่อมต่ออุปกรณ์");
        statusChannel.setShowBadge(false);
        // The service vibrates itself (with alarm usage), so the alert channel stays silent to avoid a double buzz
        NotificationChannel alertChannel = new NotificationChannel(CHANNEL_ALERT, "เตือนหลังค่อม", NotificationManager.IMPORTANCE_HIGH);
        alertChannel.setDescription("แจ้งเมื่ออุปกรณ์เริ่มสั่นเตือนหลังค่อม");
        alertChannel.enableVibration(false);
        alertChannel.setSound(null, null);
        notes.createNotificationChannel(statusChannel);
        notes.createNotificationChannel(alertChannel);
    }
}
