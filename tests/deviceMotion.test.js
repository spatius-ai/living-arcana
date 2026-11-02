import { describe, expect, it, vi } from "vitest";
import {
  createDeviceMotionService,
  MOTION_POSE_EVENT,
  normalizeDeviceOrientation,
} from "../src/motion/deviceMotion.js";

describe("device motion normalization", () => {
  const baseline = { beta: 60, gamma: 0 };

  it("maps portrait movement into bounded horizontal and vertical poses", () => {
    expect(normalizeDeviceOrientation({ beta: 67, gamma: 7 }, baseline)).toEqual({ x: 0.5, y: 0.5 });
    expect(normalizeDeviceOrientation({ beta: 120, gamma: -40 }, baseline)).toEqual({ x: -1, y: 1 });
  });

  it("rotates the axes with the device screen", () => {
    expect(normalizeDeviceOrientation({ beta: 67, gamma: 7 }, baseline, 90)).toEqual({ x: 0.5, y: -0.5 });
    expect(normalizeDeviceOrientation({ beta: 67, gamma: 7 }, baseline, 270)).toEqual({ x: -0.5, y: 0.5 });
  });
});

describe("device motion service", () => {
  it("requests permission from a trusted toggle path and publishes sensor poses", async () => {
    const listeners = new Map();
    const addEventListener = vi.fn((type, handler) => {
      const handlers = listeners.get(type) || new Set();
      handlers.add(handler);
      listeners.set(type, handlers);
    });
    const removeEventListener = vi.fn((type, handler) => listeners.get(type)?.delete(handler));
    const emit = (type, event = {}) => listeners.get(type)?.forEach((handler) => handler(event));
    class FakeCustomEvent {
      constructor(type, options) {
        this.type = type;
        this.detail = options.detail;
      }
    }
    class FakeOrientationEvent {}
    FakeOrientationEvent.requestPermission = vi.fn(async () => "granted");
    const orientationListeners = new Map();
    const windowTarget = {
      DeviceOrientationEvent: FakeOrientationEvent,
      CustomEvent: FakeCustomEvent,
      addEventListener,
      removeEventListener,
      dispatchEvent: vi.fn((event) => emit(event.type, event)),
      matchMedia: vi.fn((query) => ({
        matches: query.includes("pointer: coarse") || query.includes("hover: none"),
      })),
      screen: {
        orientation: {
          angle: 0,
          addEventListener: vi.fn((type, handler) => orientationListeners.set(type, handler)),
          removeEventListener: vi.fn((type) => orientationListeners.delete(type)),
        },
      },
      innerWidth: 390,
      innerHeight: 844,
    };
    const documentTarget = {
      hidden: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    const properties = new Map();
    const ambient = {
      style: {
        setProperty: vi.fn((key, value) => properties.set(key, value)),
        removeProperty: vi.fn((key) => properties.delete(key)),
      },
    };
    const frames = [];
    const poses = [];
    addEventListener(MOTION_POSE_EVENT, (event) => poses.push(event.detail));
    const service = createDeviceMotionService({
      windowTarget,
      documentTarget,
      storage: { getItem: () => null, setItem: vi.fn() },
      requestFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      cancelFrame: vi.fn(),
      now: () => 0,
    });

    const cleanup = service.mount({ querySelector: () => ambient });
    await expect(service.enable()).resolves.toBe(true);
    expect(FakeOrientationEvent.requestPermission).toHaveBeenCalledOnce();
    expect(service.getState()).toMatchObject({ supported: true, enabled: true, permission: "granted" });

    emit("deviceorientation", { beta: 60, gamma: 0 });
    emit("deviceorientation", { beta: 67, gamma: 7 });
    frames.shift()(16);

    expect(poses.at(-1)).toEqual({ active: true, x: 0.5, y: 0.5 });
    expect(properties.get("--ambient-parallax-x")).not.toBe("0.00px");
    cleanup();
    expect(service.getState().enabled).toBe(false);
  });
});
