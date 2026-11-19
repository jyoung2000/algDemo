// CAR-SETTINGS-001: the car's EQ / discovery / mood choices become the phone's settings, and the phone's reach the car.
import { describe, expect, it, vi } from 'vitest';
import { applyCarSettings, discoveryForEngine } from './car-settings';
import { carSettingsFrom } from './media-native';

describe('car settings on the page', () => {
  it('saves the car’s choice first, then tells the engine it has it', async () => {
    const order: string[] = [];
    const save = vi.fn(async () => { order.push('save'); });
    const send = vi.fn(() => { order.push('send'); });
    const eq = carSettingsFrom({ eq: { on: true, presetId: 'rock', gains: [5, 4, 3, 1.5, -0.5, -1, 0.5, 3, 4, 4.5] } })!.eq!;
    await applyCarSettings({ eq, adventurous: 0.7 }, { save, send });
    expect(save).toHaveBeenCalledWith({ eq, adventurous: 0.7 });
    expect(send).toHaveBeenCalledWith({ op: 'settings', eq, adventurous: 0.7 });
    expect(order).toEqual(['save', 'send']);
  });

  it('does not echo a choice that could not be saved', async () => {
    const send = vi.fn();
    await expect(applyCarSettings({ mood_queue: false }, { save: async () => { throw new Error('offline'); }, send })).rejects.toThrow('offline');
    expect(send).not.toHaveBeenCalled();
  });

  it('the phone’s discovery level and mood switch go to the engine for the car’s buttons', () => {
    expect(discoveryForEngine({ adventurous: 0.25, mood_queue: false })).toEqual({ op: 'settings', adventurous: 0.25, mood_queue: false });
    expect(discoveryForEngine({})).toEqual({ op: 'settings', adventurous: 0.5, mood_queue: true });
    expect(discoveryForEngine({ adventurous: 7 })!.adventurous).toBe(1);
    expect(discoveryForEngine(null)).toBeNull();
  });
});
