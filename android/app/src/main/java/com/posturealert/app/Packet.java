package com.posturealert.app;

/**
 * Status packet sent by the posture_v4 firmware: 20 bytes, little endian.
 * Same layout as js/protocol.js, kept in step with it by hand.
 */
final class Packet {
    static final int SIZE = 20;
    static final int OK = 0, SLOUCH = 1, MOVING = 2, LYING = 3, SNOOZE = 4, SENSOR = 5;
    /** One sensor only: the firmware alerts 5 degrees later than the set threshold. */
    static final int SINGLE_SENSOR_EXTRA = 5;
    private static final String[] LABELS = {"นั่งตรง", "หลังค่อม", "กำลังขยับ", "นอน / ก้มมาก", "พักเตือน", "เซนเซอร์มีปัญหา"};

    final int state;
    final boolean alarm;
    final boolean twoSensors;
    final float curve;
    final int batteryMv;
    final int threshold;

    private Packet(byte[] b) {
        state = b[0] & 0xFF;
        int flags = b[1] & 0xFF;
        alarm = (flags & 1) != 0;
        twoSensors = (flags & 2) != 0;
        boolean battOk = (flags & 4) != 0;
        curve = (short) ((b[6] & 0xFF) | (b[7] << 8)) / 10f;
        batteryMv = battOk ? ((b[8] & 0xFF) | ((b[9] & 0xFF) << 8)) : 0;
        threshold = b[16] & 0xFF;
    }

    /** Returns null for anything that is not a full packet. */
    static Packet parse(byte[] b) {
        return b != null && b.length >= SIZE ? new Packet(b) : null;
    }

    String label() {
        return state >= 0 && state < LABELS.length ? LABELS[state] : "ไม่ทราบสถานะ";
    }

    int effectiveThreshold() {
        return twoSensors ? threshold : threshold + SINGLE_SENSOR_EXTRA;
    }

    /** e.g. "นั่งตรง · 2.1°" — no angle when the sensor is not answering. */
    String summary() {
        if (state == SENSOR) return label();
        return String.format(java.util.Locale.US, "%s · %.1f°", label(), curve);
    }
}
