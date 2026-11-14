// Standalone arithmetic oracle derived from the audited 26.1 methods listed in docs/walking-26.1.md.
// No Minecraft code or libraries are loaded. Java evaluates each float operation for the fixtures.
import java.util.Locale;

public class WalkingReference {
    static boolean modern;
    static float frictionModifier = 1f, airDragModifier = 1f;
    static float modifiedFriction(float base, float modifier) {
        return Math.max(0f, Math.min(1f, 1f - (1f - base) * modifier));
    }
    static final float[] SIN = new float[65536];
    static {
        for (int i = 0; i < SIN.length; i++) SIN[i] = (float)Math.sin(i * Math.PI * 2.0 / 65536.0);
    }
    static float[] input(int right, int forward, boolean sneak, float use) {
        float len = (float)Math.sqrt(right * right + forward * forward);
        if (len == 0) return new float[]{0, 0};
        float x = right / len * 0.98f, z = forward / len * 0.98f;
        x *= use; z *= use;
        if (sneak) { x *= 0.3f; z *= 0.3f; }
        len = (float)Math.sqrt(x * x + z * z);
        if (len == 0) return new float[]{0, 0};
        float inverse = 1.0f / len;
        x *= inverse; z *= inverse;
        float ratio = Math.min(Math.abs(x), Math.abs(z)) / Math.max(Math.abs(x), Math.abs(z));
        float scale = Math.min(len * (float)Math.sqrt(1.0f + ratio * ratio), 1.0f);
        return new float[]{x * scale, z * scale};
    }
    static void sample(String name, float yaw, int right, int forward, boolean sprint,
                       boolean sneak, float slip, double speed, float use, boolean jump, int boost) {
        System.out.printf(Locale.ROOT, "{\"version\":\"%s\",\"frictionModifier\":%s,\"airDragModifier\":%s,\"name\":\"%s\",\"yaw\":%s,\"right\":%d,\"forward\":%d,\"sprint\":%s,\"sneak\":%s,\"slip\":%s,\"speed\":%s,\"use\":%s,\"jump\":%s,\"boost\":%d,\"frames\":[",
            modern ? "26.2" : "26.1", frictionModifier, airDragModifier, name, yaw, right, forward, sprint, sneak, slip, speed, use, jump, boost);
        double x = 0.5, y = 1, z = 0.5, vx = 0, vy = -0.08 * 0.98f, vz = 0;
        boolean ground = true, first = true;
        float radians = yaw * 0.017453292f;
        float sin = SIN[(int)((long)(radians * 10430.378350470453)) & 65535];
        float cos = SIN[(int)((long)(radians * 10430.378350470453 + 16384.0)) & 65535];
        for (int tick = 1; tick <= 60; tick++) {
            if (vx * vx + vz * vz < 9e-6) { vx = 0; vz = 0; }
            if (Math.abs(vy) < 0.003) vy = 0;
            boolean running = sprint && tick <= 40;
            if (jump && tick == 1) {
                vy = Math.max(vy, 0.42f + 0.1f * boost);
                if (running) { vx -= sin * 0.2; vz += cos * 0.2; }
            }
            float friction = ground ? (modern ? modifiedFriction(slip, frictionModifier) : slip) : 1.0f;
            float inertia = friction * (modern ? modifiedFriction(0.91f, airDragModifier) : 0.91f);
            float accel;
            if (ground) {
                accel = (float)(speed * (running ? 1.3 : 1));
                if (!modern || friction > 0.6) accel *= 0.21600002f / (friction * friction * friction);
            } else accel = running ? 0.025999999f : 0.02f;
            float[] keys = input(tick <= 40 ? right : 0, tick <= 40 ? forward : 0, sneak, use);
            double ix = -keys[0], iz = keys[1];
            double sq = ix * ix + iz * iz;
            if (sq >= 1e-7) {
                if (sq > 1) { double inverse = 1.0 / Math.sqrt(sq); ix *= inverse; iz *= inverse; }
                ix *= accel; iz *= accel;
                vx += ix * cos - iz * sin;
                vz += iz * cos + ix * sin;
            }
            double dx = Math.abs(vx) < 1e-7 ? 0 : vx;
            double dz = Math.abs(vz) < 1e-7 ? 0 : vz;
            double dy = Math.abs(vy) < 1e-7 ? 0 : vy;
            if (y + dy < 1) dy = 1 - y;
            ground = dy != vy && vy < 0;
            x += dx; y += dy; z += dz;
            if (dy != vy) vy = 0;
            vx *= inertia; vy = (vy - 0.08) * (modern ? modifiedFriction(0.98f, airDragModifier) : 0.98f); vz *= inertia;
            if (tick == 1 || tick == 2 || tick == 10 || tick == 20 || tick == 40 || tick == 41 || tick == 45 || tick == 60) {
                if (!first) System.out.print(","); first = false;
                System.out.printf(Locale.ROOT, "{\"tick\":%d,\"position\":[%s,%s,%s],\"velocity\":[%s,%s,%s]}", tick, x, y, z, vx, vy, vz);
            }
        }
        System.out.print("]}");
    }
    public static void main(String[] args) {
        modern = args.length > 0 && args[0].equals("26.2");
        System.out.print("[\n");
        sample("walk", 180f, 0, 1, false, false, 0.6f, 0.1, 1f, false, 0); System.out.print(",\n");
        sample("diagonal", 37.12345f, 1, 1, false, false, 0.6f, 0.1, 1f, false, 0); System.out.print(",\n");
        sample("sprint", -147.25f, -1, 1, true, false, 0.6f, 0.1, 1f, false, 0); System.out.print(",\n");
        sample("sneak", 81f, 1, 1, false, true, 0.6f, 0.1, 1f, false, 0); System.out.print(",\n");
        sample("ice", 12.678f, 0, 1, true, false, 0.98f, 0.1, 1f, false, 0); System.out.print(",\n");
        sample("blue_ice", 359.99f, -1, 1, false, false, 0.989f, 0.1, 1f, false, 0); System.out.print(",\n");
        sample("attribute", 721.234f, 0, 1, true, false, 0.6f, 0.153, 1f, false, 0); System.out.print(",\n");
        sample("item", 76.75f, 1, 1, false, false, 0.6f, 0.1, 0.2f, false, 0); System.out.print(",\n");
        sample("jump", 79.123f, 0, 1, true, false, 0.6f, 0.1, 1f, true, 0); System.out.print(",\n");
        sample("jump_boost", 180f, 0, 1, true, false, 0.6f, 0.1, 1f, true, 2);
        if (modern) {
            System.out.print(",\n"); frictionModifier = 2f;
            sample("high_friction", 72.5f, 1, 1, true, false, 0.6f, 0.1, 1f, false, 0);
            System.out.print(",\n"); frictionModifier = 0.5f; airDragModifier = 2f;
            sample("drag_jump", -91.23f, 0, 1, true, false, 0.6f, 0.1, 1f, true, 0);
            System.out.print(",\n"); frictionModifier = 4f; airDragModifier = 0.5f;
            sample("zero_friction_factor", 13.5f, 0, 1, false, false, 0.6f, 0.1, 1f, false, 0);
        }
        System.out.println("\n]");
    }
}
