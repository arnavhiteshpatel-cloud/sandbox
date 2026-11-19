// AirMixDSP — see AirMixDSP.h for the threading contract.

#include "AirMixDSP.h"

#include <math.h>
#include <stdatomic.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

typedef struct {
    int count;
    float preamp;
    amx_biquad bands[AMX_MAX_BANDS];
} amx_eq_set;

struct amx_processor {
    double sample_rate;

    // ---- parameters written by the control thread ----
    _Atomic float target_gain;
    _Atomic float gain_jump;           // NaN = none; otherwise audio thread snaps to this value
    _Atomic float gain_tau_ms;
    _Atomic int eq_enabled;
    _Atomic int limiter_enabled;
    _Atomic float limiter_ceiling;
    _Atomic int voice_enabled;
    _Atomic int input_buffer_index;
    _Atomic int input_channel_offset;

    // ---- EQ triple buffer ----
    amx_eq_set eq_slots[3];
    _Atomic uint32_t eq_middle;        // slot index | AMX_FRESH
    int eq_front;                      // owned by the audio thread
    int eq_back;                       // owned by the control thread

    // ---- audio-thread state ----
    float gain;
    float gain_coef;
    float gain_coef_tau;               // tau the coefficient was computed for
    float eq_mix;
    float eq_mix_coef;
    bool eq_running;
    int active_bands;
    double z[AMX_MAX_BANDS][2][2];
    float limiter_gr;
    float limiter_release;
    double input_ms;                   // smoothed mean square of the input
    double env_coef;
    amx_biquad vd_hp, vd_lp;
    double vd_z[2][2];
    double vd_speech, vd_total;

    // ---- meters written by the audio thread ----
    _Atomic float meter_peak_l;
    _Atomic float meter_peak_r;
    _Atomic float meter_input_rms;
    _Atomic float meter_voice;
    _Atomic uint32_t meter_clips;
    _Atomic uint64_t meter_frames;
    _Atomic uint32_t meter_callbacks;
    _Atomic float meter_gain;

    float scratch_l[AMX_MAX_CHUNK];
    float scratch_r[AMX_MAX_CHUNK];
};

#define AMX_FRESH 4u

static inline float clampf(float v, float lo, float hi) { return v < lo ? lo : (v > hi ? hi : v); }

static float coef_for_ms(double sample_rate, double ms) {
    if (ms <= 0.0) return 1.0f;
    return (float)(1.0 - exp(-1.0 / (ms * 0.001 * sample_rate)));
}

static void recompute_rate_dependent(amx_processor *p) {
    double fs = p->sample_rate;
    p->gain_coef_tau = atomic_load_explicit(&p->gain_tau_ms, memory_order_relaxed);
    p->gain_coef = coef_for_ms(fs, p->gain_coef_tau);
    p->eq_mix_coef = coef_for_ms(fs, 6.0);
    p->limiter_release = coef_for_ms(fs, 80.0);
    p->env_coef = 1.0 - exp(-1.0 / (0.050 * fs)); // 50 ms level follower
    p->vd_hp = amx_design(AMX_HIGH_PASS, fs, 300.0, 0.7071, 0.0);
    p->vd_lp = amx_design(AMX_LOW_PASS, fs, 3400.0, 0.7071, 0.0);
}

amx_processor *amx_processor_create(double sample_rate) {
    amx_processor *p = (amx_processor *)calloc(1, sizeof(amx_processor));
    if (!p) return NULL;
    p->sample_rate = sample_rate > 1000.0 ? sample_rate : 48000.0;
    atomic_init(&p->target_gain, 1.0f);
    atomic_init(&p->gain_jump, NAN);
    atomic_init(&p->gain_tau_ms, 12.0f);
    atomic_init(&p->eq_enabled, 0);
    atomic_init(&p->limiter_enabled, 1);
    atomic_init(&p->limiter_ceiling, 0.98f);
    atomic_init(&p->voice_enabled, 0);
    atomic_init(&p->input_buffer_index, -1);
    atomic_init(&p->input_channel_offset, 0);
    for (int i = 0; i < 3; i++) { p->eq_slots[i].count = 0; p->eq_slots[i].preamp = 1.0f; }
    p->eq_front = 0;
    atomic_init(&p->eq_middle, 1u);
    p->eq_back = 2;
    p->gain = 1.0f;
    p->limiter_gr = 1.0f;
    atomic_init(&p->meter_peak_l, 0.0f);
    atomic_init(&p->meter_peak_r, 0.0f);
    atomic_init(&p->meter_input_rms, 0.0f);
    atomic_init(&p->meter_voice, 0.0f);
    atomic_init(&p->meter_clips, 0u);
    atomic_init(&p->meter_frames, 0u);
    atomic_init(&p->meter_callbacks, 0u);
    atomic_init(&p->meter_gain, 1.0f);
    recompute_rate_dependent(p);
    return p;
}

void amx_processor_destroy(amx_processor *p) { free(p); }

void amx_processor_set_sample_rate(amx_processor *p, double sample_rate) {
    if (!p || sample_rate < 1000.0) return;
    p->sample_rate = sample_rate;
    recompute_rate_dependent(p);
    memset(p->z, 0, sizeof(p->z));
    memset(p->vd_z, 0, sizeof(p->vd_z));
}

double amx_processor_sample_rate(const amx_processor *p) { return p ? p->sample_rate : 0.0; }

// ---------------------------------------------------------------- parameters

void amx_set_gain(amx_processor *p, float g) {
    if (!p || !isfinite(g)) return;
    atomic_store_explicit(&p->target_gain, clampf(g, 0.0f, 16.0f), memory_order_relaxed);
}

void amx_set_gain_immediate(amx_processor *p, float g) {
    if (!p || !isfinite(g)) return;
    g = clampf(g, 0.0f, 16.0f);
    atomic_store_explicit(&p->target_gain, g, memory_order_relaxed);
    atomic_store_explicit(&p->gain_jump, g, memory_order_release);
}

void amx_set_gain_smoothing_ms(amx_processor *p, float ms) {
    if (!p || !isfinite(ms)) return;
    atomic_store_explicit(&p->gain_tau_ms, clampf(ms, 0.0f, 500.0f), memory_order_relaxed);
}

void amx_set_eq(amx_processor *p, const amx_biquad *bands, int count, float preamp) {
    if (!p) return;
    if (count < 0) count = 0;
    if (count > AMX_MAX_BANDS) count = AMX_MAX_BANDS;
    amx_eq_set *slot = &p->eq_slots[p->eq_back];
    slot->count = count;
    slot->preamp = isfinite(preamp) ? clampf(preamp, 0.0f, 8.0f) : 1.0f;
    for (int i = 0; i < count; i++) slot->bands[i] = bands[i];
    uint32_t prev = atomic_exchange_explicit(&p->eq_middle, (uint32_t)p->eq_back | AMX_FRESH,
                                             memory_order_acq_rel);
    p->eq_back = (int)(prev & 3u);
}

void amx_set_eq_enabled(amx_processor *p, bool enabled) {
    if (p) atomic_store_explicit(&p->eq_enabled, enabled ? 1 : 0, memory_order_relaxed);
}

void amx_set_limiter(amx_processor *p, bool enabled, float ceiling) {
    if (!p) return;
    if (!isfinite(ceiling)) ceiling = 0.98f;
    atomic_store_explicit(&p->limiter_ceiling, clampf(ceiling, 0.1f, 1.0f), memory_order_relaxed);
    atomic_store_explicit(&p->limiter_enabled, enabled ? 1 : 0, memory_order_relaxed);
}

void amx_set_voice_detection(amx_processor *p, bool enabled) {
    if (p) atomic_store_explicit(&p->voice_enabled, enabled ? 1 : 0, memory_order_relaxed);
}

void amx_set_input_layout(amx_processor *p, int buffer_index, int channel_offset) {
    if (!p) return;
    atomic_store_explicit(&p->input_buffer_index, buffer_index, memory_order_relaxed);
    atomic_store_explicit(&p->input_channel_offset, channel_offset < 0 ? 0 : channel_offset,
                          memory_order_relaxed);
}

// ---------------------------------------------------------------- meters

static inline void atomic_max_float(_Atomic float *a, float v) {
    float cur = atomic_load_explicit(a, memory_order_relaxed);
    while (v > cur &&
           !atomic_compare_exchange_weak_explicit(a, &cur, v, memory_order_relaxed, memory_order_relaxed)) {
    }
}

void amx_read_meters(amx_processor *p, amx_meters *out) {
    if (!p || !out) return;
    out->peak_left = atomic_exchange_explicit(&p->meter_peak_l, 0.0f, memory_order_relaxed);
    out->peak_right = atomic_exchange_explicit(&p->meter_peak_r, 0.0f, memory_order_relaxed);
    out->input_rms = atomic_load_explicit(&p->meter_input_rms, memory_order_relaxed);
    out->voice_ratio = atomic_load_explicit(&p->meter_voice, memory_order_relaxed);
    out->clip_events = atomic_exchange_explicit(&p->meter_clips, 0u, memory_order_relaxed);
    out->frames = atomic_load_explicit(&p->meter_frames, memory_order_relaxed);
    out->callbacks = atomic_load_explicit(&p->meter_callbacks, memory_order_relaxed);
    out->current_gain = atomic_load_explicit(&p->meter_gain, memory_order_relaxed);
}

uint32_t amx_callback_count(const amx_processor *p) {
    return p ? atomic_load_explicit(&((amx_processor *)p)->meter_callbacks, memory_order_relaxed) : 0;
}

float amx_input_rms(const amx_processor *p) {
    return p ? atomic_load_explicit(&((amx_processor *)p)->meter_input_rms, memory_order_relaxed) : 0.0f;
}

// ---------------------------------------------------------------- processing

static inline double biquad_tick(const amx_biquad *c, double *z, double x) {
    double y = c->b0 * x + z[0];
    z[0] = c->b1 * x - c->a1 * y + z[1];
    z[1] = c->b2 * x - c->a2 * y;
    return y;
}

static inline double flush_denormal(double v) { return fabs(v) < 1e-20 ? 0.0 : v; }

void amx_process_stereo(amx_processor *p, const float *in_l, const float *in_r,
                        float *out_l, float *out_r, uint32_t frames) {
    if (!p || frames == 0) return;

    // Pick up a freshly published EQ (wait-free).
    if (atomic_load_explicit(&p->eq_middle, memory_order_acquire) & AMX_FRESH) {
        uint32_t prev = atomic_exchange_explicit(&p->eq_middle, (uint32_t)p->eq_front, memory_order_acq_rel);
        p->eq_front = (int)(prev & 3u);
    }
    const amx_eq_set *eq = &p->eq_slots[p->eq_front];
    const int nb = eq->count;
    if (nb != p->active_bands) {
        // New bands start from silence; existing bands keep their state for click-free edits.
        for (int b = nb; b < AMX_MAX_BANDS; b++) memset(p->z[b], 0, sizeof(p->z[b]));
        p->active_bands = nb;
    }

    float jump = atomic_exchange_explicit(&p->gain_jump, NAN, memory_order_acquire);
    if (!isnan(jump)) p->gain = jump;
    float tau = atomic_load_explicit(&p->gain_tau_ms, memory_order_relaxed);
    if (tau != p->gain_coef_tau) {
        p->gain_coef_tau = tau;
        p->gain_coef = coef_for_ms(p->sample_rate, tau);
    }

    const float target = atomic_load_explicit(&p->target_gain, memory_order_relaxed);
    const float eq_target = atomic_load_explicit(&p->eq_enabled, memory_order_relaxed) ? 1.0f : 0.0f;
    const bool limiter = atomic_load_explicit(&p->limiter_enabled, memory_order_relaxed) != 0;
    const float ceiling = atomic_load_explicit(&p->limiter_ceiling, memory_order_relaxed);
    const bool voice = atomic_load_explicit(&p->voice_enabled, memory_order_relaxed) != 0;
    const float preamp = eq->preamp;

    if (eq_target > 0.0f && !p->eq_running) {
        memset(p->z, 0, sizeof(p->z));
        p->eq_running = true;
    }

    float g = p->gain;
    const float gc = p->gain_coef;
    float mix = p->eq_mix;
    const float mc = p->eq_mix_coef;
    float gr = p->limiter_gr;
    const float rel = p->limiter_release;
    double ms = p->input_ms;
    const double ec = p->env_coef;
    double vs = p->vd_speech, vt = p->vd_total;
    float pk_l = 0.0f, pk_r = 0.0f;
    uint32_t clips = 0;

    for (uint32_t i = 0; i < frames; i++) {
        float l = in_l[i];
        float r = in_r[i];

        // Pre-gain level (drives activity detection, independent of this app's own volume).
        double m2 = 0.5 * ((double)l * l + (double)r * r);
        ms += (m2 - ms) * ec;
        if (voice) {
            double mono = 0.5 * ((double)l + (double)r);
            double s = biquad_tick(&p->vd_lp, p->vd_z[1], biquad_tick(&p->vd_hp, p->vd_z[0], mono));
            vs += (s * s - vs) * ec;
            vt += (mono * mono - vt) * ec;
        }

        // Equaliser with click-free bypass crossfade.
        if (p->eq_running) {
            mix += (eq_target - mix) * mc;
            double wl = l, wr = r;
            for (int b = 0; b < nb; b++) {
                wl = biquad_tick(&eq->bands[b], p->z[b][0], wl);
                wr = biquad_tick(&eq->bands[b], p->z[b][1], wr);
            }
            float fl = (float)wl * preamp;
            float fr = (float)wr * preamp;
            l += mix * (fl - l);
            r += mix * (fr - r);
        }

        // Smoothed gain (volume × mute × ducking).
        g += (target - g) * gc;
        l *= g;
        r *= g;

        // Zero-latency brick-wall limiter: instant attack, smooth release.
        if (limiter) {
            float a = fabsf(l) > fabsf(r) ? fabsf(l) : fabsf(r);
            if (a * gr > ceiling) {
                gr = ceiling / a;
                clips++;
            }
            l *= gr;
            r *= gr;
            gr += (1.0f - gr) * rel;
        }

        float al = fabsf(l), ar = fabsf(r);
        if (al > pk_l) pk_l = al;
        if (ar > pk_r) pk_r = ar;
        out_l[i] = l;
        out_r[i] = r;
    }

    if (fabsf(g - target) < 1e-4f * (target > 1.0f ? target : 1.0f)) g = target; // within -80 dB: snap
    if (p->eq_running && eq_target == 0.0f && mix < 1e-4f) {
        mix = 0.0f;
        p->eq_running = false;
    } else if (eq_target == 1.0f && mix > 0.9999f) {
        mix = 1.0f;
    }
    for (int b = 0; b < nb; b++)
        for (int c = 0; c < 2; c++) {
            p->z[b][c][0] = flush_denormal(p->z[b][c][0]);
            p->z[b][c][1] = flush_denormal(p->z[b][c][1]);
        }
    for (int k = 0; k < 2; k++) {
        p->vd_z[k][0] = flush_denormal(p->vd_z[k][0]);
        p->vd_z[k][1] = flush_denormal(p->vd_z[k][1]);
    }

    p->gain = g;
    p->eq_mix = mix;
    p->limiter_gr = gr;
    p->input_ms = flush_denormal(ms);
    p->vd_speech = flush_denormal(vs);
    p->vd_total = flush_denormal(vt);

    atomic_max_float(&p->meter_peak_l, pk_l);
    atomic_max_float(&p->meter_peak_r, pk_r);
    atomic_store_explicit(&p->meter_input_rms, (float)sqrt(p->input_ms), memory_order_relaxed);
    if (voice) {
        float ratio = (float)(p->vd_total > 1e-12 ? p->vd_speech / p->vd_total : 0.0);
        atomic_store_explicit(&p->meter_voice, clampf(ratio, 0.0f, 1.0f), memory_order_relaxed);
    }
    if (clips) atomic_fetch_add_explicit(&p->meter_clips, clips, memory_order_relaxed);
    atomic_fetch_add_explicit(&p->meter_frames, frames, memory_order_relaxed);
    atomic_store_explicit(&p->meter_gain, g, memory_order_relaxed);
}

void amx_process_buffers(amx_processor *p, const amx_buffer *in, uint32_t in_count,
                         amx_buffer *out, uint32_t out_count) {
    if (!p) return;
    atomic_fetch_add_explicit(&p->meter_callbacks, 1u, memory_order_relaxed);

    // Destinations: the first two output channels, which may live in one interleaved buffer or in
    // two separate (mono) buffers. Every output buffer is cleared first; we then write L/R.
    amx_buffer *dst_l = NULL, *dst_r = NULL;
    uint32_t ch_l = 0, ch_r = 0;
    uint32_t out_frames = UINT32_MAX;
    for (uint32_t k = 0; k < out_count; k++) {
        if (!out[k].data || out[k].channels == 0 || out[k].byte_size == 0) continue;
        memset(out[k].data, 0, out[k].byte_size);
        uint32_t frames_k = out[k].byte_size / (uint32_t)(sizeof(float) * out[k].channels);
        for (uint32_t c = 0; c < out[k].channels; c++) {
            if (!dst_l) { dst_l = &out[k]; ch_l = c; if (frames_k < out_frames) out_frames = frames_k; }
            else if (!dst_r) { dst_r = &out[k]; ch_r = c; if (frames_k < out_frames) out_frames = frames_k; }
        }
    }
    if (!dst_l) return;

    // Source: configured buffer, or the last non-empty one (process taps follow sub-device streams).
    const amx_buffer *src = NULL;
    const int idx = atomic_load_explicit(&p->input_buffer_index, memory_order_relaxed);
    if (in && in_count > 0) {
        if (idx >= 0 && (uint32_t)idx < in_count) {
            src = &in[idx];
        } else if (idx < 0) {
            for (int k = (int)in_count - 1; k >= 0; k--) {
                if (in[k].data && in[k].channels > 0 && in[k].byte_size > 0) { src = &in[k]; break; }
            }
        }
    }
    uint32_t in_ch = 0, in_frames = 0;
    const float *s = NULL;
    if (src && src->data && src->channels > 0) {
        in_ch = src->channels;
        in_frames = src->byte_size / (uint32_t)(sizeof(float) * in_ch);
        s = (const float *)src->data;
    }
    uint32_t off = (uint32_t)atomic_load_explicit(&p->input_channel_offset, memory_order_relaxed);
    if (off >= in_ch) off = 0;
    const uint32_t avail = in_ch > off ? in_ch - off : 0;
    const uint32_t n = in_frames < out_frames ? in_frames : out_frames;

    uint32_t done = 0;
    while (done < n) {
        uint32_t chunk = n - done;
        if (chunk > AMX_MAX_CHUNK) chunk = AMX_MAX_CHUNK;
        float *L = p->scratch_l, *R = p->scratch_r;
        const float *sp = s + (size_t)done * in_ch + off;
        if (avail >= 2) {
            for (uint32_t f = 0; f < chunk; f++) { L[f] = sp[0]; R[f] = sp[1]; sp += in_ch; }
        } else {
            for (uint32_t f = 0; f < chunk; f++) { L[f] = R[f] = sp[0]; sp += in_ch; }
        }
        amx_process_stereo(p, L, R, L, R, chunk);
        const uint32_t sl = dst_l->channels;
        float *dl = (float *)dst_l->data + (size_t)done * sl + ch_l;
        if (dst_r) {
            const uint32_t sr = dst_r->channels;
            float *dr = (float *)dst_r->data + (size_t)done * sr + ch_r;
            for (uint32_t f = 0; f < chunk; f++) { *dl = L[f]; *dr = R[f]; dl += sl; dr += sr; }
        } else {
            for (uint32_t f = 0; f < chunk; f++) { *dl = 0.5f * (L[f] + R[f]); dl += sl; }
        }
        done += chunk;
    }
    // Frames beyond n stay silent (buffers were cleared above).
}

// ---------------------------------------------------------------- design

amx_biquad amx_design(amx_filter_type type, double fs, double f0, double q, double gain_db) {
    amx_biquad c = {1.0, 0.0, 0.0, 0.0, 0.0};
    if (!(fs > 0.0)) return c;
    if (!(f0 > 1.0)) f0 = 1.0;
    if (f0 > 0.49 * fs) f0 = 0.49 * fs;
    if (!(q > 0.01)) q = 0.01;
    if (q > 40.0) q = 40.0;
    if (!isfinite(gain_db)) gain_db = 0.0;
    const double A = pow(10.0, gain_db / 40.0);
    const double w0 = 2.0 * M_PI * f0 / fs;
    const double cw = cos(w0), sw = sin(w0);
    const double alpha = sw / (2.0 * q);
    const double sA = sqrt(A);
    double b0 = 1, b1 = 0, b2 = 0, a0 = 1, a1 = 0, a2 = 0;
    switch (type) {
    case AMX_PEAKING:
        b0 = 1 + alpha * A; b1 = -2 * cw; b2 = 1 - alpha * A;
        a0 = 1 + alpha / A; a1 = -2 * cw; a2 = 1 - alpha / A;
        break;
    case AMX_LOW_SHELF:
        b0 = A * ((A + 1) - (A - 1) * cw + 2 * sA * alpha);
        b1 = 2 * A * ((A - 1) - (A + 1) * cw);
        b2 = A * ((A + 1) - (A - 1) * cw - 2 * sA * alpha);
        a0 = (A + 1) + (A - 1) * cw + 2 * sA * alpha;
        a1 = -2 * ((A - 1) + (A + 1) * cw);
        a2 = (A + 1) + (A - 1) * cw - 2 * sA * alpha;
        break;
    case AMX_HIGH_SHELF:
        b0 = A * ((A + 1) + (A - 1) * cw + 2 * sA * alpha);
        b1 = -2 * A * ((A - 1) + (A + 1) * cw);
        b2 = A * ((A + 1) + (A - 1) * cw - 2 * sA * alpha);
        a0 = (A + 1) - (A - 1) * cw + 2 * sA * alpha;
        a1 = 2 * ((A - 1) - (A + 1) * cw);
        a2 = (A + 1) - (A - 1) * cw - 2 * sA * alpha;
        break;
    case AMX_LOW_PASS:
        b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2;
        a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
        break;
    case AMX_HIGH_PASS:
        b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2;
        a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
        break;
    case AMX_NOTCH:
        b0 = 1; b1 = -2 * cw; b2 = 1;
        a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
        break;
    case AMX_BAND_PASS:
        b0 = alpha; b1 = 0; b2 = -alpha;
        a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
        break;
    }
    c.b0 = b0 / a0; c.b1 = b1 / a0; c.b2 = b2 / a0; c.a1 = a1 / a0; c.a2 = a2 / a0;
    return c;
}

double amx_cascade_magnitude_db(const amx_biquad *bands, int count, double fs, double f) {
    const double w = 2.0 * M_PI * f / fs;
    const double c1 = cos(w), s1 = sin(w), c2 = cos(2 * w), s2 = sin(2 * w);
    double db = 0.0;
    for (int i = 0; i < count; i++) {
        const amx_biquad *b = &bands[i];
        double nr = b->b0 + b->b1 * c1 + b->b2 * c2;
        double ni = -(b->b1 * s1 + b->b2 * s2);
        double dr = 1.0 + b->a1 * c1 + b->a2 * c2;
        double di = -(b->a1 * s1 + b->a2 * s2);
        double num = nr * nr + ni * ni, den = dr * dr + di * di;
        if (den < 1e-300) den = 1e-300;
        if (num < 1e-300) num = 1e-300;
        db += 10.0 * log10(num / den);
    }
    return db;
}

// ---------------------------------------------------------------- recorder

struct amx_recorder {
    uint32_t capacity;
    _Atomic uint32_t frames;
    float *data;
};

amx_recorder *amx_recorder_create(uint32_t capacity) {
    amx_recorder *r = (amx_recorder *)calloc(1, sizeof(amx_recorder));
    if (!r) return NULL;
    r->data = (float *)calloc(capacity ? capacity : 1, sizeof(float));
    if (!r->data) { free(r); return NULL; }
    r->capacity = capacity;
    atomic_init(&r->frames, 0u);
    return r;
}

void amx_recorder_destroy(amx_recorder *r) {
    if (!r) return;
    free(r->data);
    free(r);
}

void amx_recorder_write(amx_recorder *r, const amx_buffer *in, uint32_t in_count) {
    if (!r || !in) return;
    const amx_buffer *src = NULL;
    for (int k = (int)in_count - 1; k >= 0; k--)
        if (in[k].data && in[k].channels > 0 && in[k].byte_size > 0) { src = &in[k]; break; }
    if (!src) return;
    uint32_t have = atomic_load_explicit(&r->frames, memory_order_relaxed);
    if (have >= r->capacity) return;
    const uint32_t ch = src->channels;
    uint32_t n = src->byte_size / (uint32_t)(sizeof(float) * ch);
    if (n > r->capacity - have) n = r->capacity - have;
    const float *s = (const float *)src->data;
    for (uint32_t f = 0; f < n; f++) {
        r->data[have + f] = ch >= 2 ? 0.5f * (s[f * ch] + s[f * ch + 1]) : s[f * ch];
    }
    atomic_store_explicit(&r->frames, have + n, memory_order_release);
}

uint32_t amx_recorder_frames(const amx_recorder *r) {
    return r ? atomic_load_explicit(&((amx_recorder *)r)->frames, memory_order_acquire) : 0;
}

const float *amx_recorder_data(const amx_recorder *r) { return r ? r->data : NULL; }

void amx_recorder_reset(amx_recorder *r) {
    if (r) atomic_store_explicit(&r->frames, 0u, memory_order_release);
}

// ---------------------------------------------------------------- Core Audio glue

#ifdef __APPLE__
_Static_assert(sizeof(amx_buffer) == sizeof(AudioBuffer), "amx_buffer must mirror AudioBuffer");
_Static_assert(offsetof(amx_buffer, channels) == offsetof(AudioBuffer, mNumberChannels), "layout");
_Static_assert(offsetof(amx_buffer, byte_size) == offsetof(AudioBuffer, mDataByteSize), "layout");
_Static_assert(offsetof(amx_buffer, data) == offsetof(AudioBuffer, mData), "layout");

OSStatus amx_core_audio_ioproc(AudioObjectID device, const AudioTimeStamp *now,
                               const AudioBufferList *input_data, const AudioTimeStamp *input_time,
                               AudioBufferList *output_data, const AudioTimeStamp *output_time,
                               void *client_data) {
    (void)device; (void)now; (void)input_time; (void)output_time;
    amx_processor *p = (amx_processor *)client_data;
    if (!p || !output_data) return noErr;
    const amx_buffer *in = input_data ? (const amx_buffer *)input_data->mBuffers : NULL;
    const uint32_t in_count = input_data ? input_data->mNumberBuffers : 0;
    amx_process_buffers(p, in, in_count, (amx_buffer *)output_data->mBuffers, output_data->mNumberBuffers);
    return noErr;
}

static OSStatus amx_recorder_ioproc(AudioObjectID device, const AudioTimeStamp *now,
                                    const AudioBufferList *input_data, const AudioTimeStamp *input_time,
                                    AudioBufferList *output_data, const AudioTimeStamp *output_time,
                                    void *client_data) {
    (void)device; (void)now; (void)input_time; (void)output_time;
    amx_recorder *r = (amx_recorder *)client_data;
    if (output_data) {
        for (UInt32 k = 0; k < output_data->mNumberBuffers; k++)
            if (output_data->mBuffers[k].mData)
                memset(output_data->mBuffers[k].mData, 0, output_data->mBuffers[k].mDataByteSize);
    }
    if (r && input_data)
        amx_recorder_write(r, (const amx_buffer *)input_data->mBuffers, input_data->mNumberBuffers);
    return noErr;
}

OSStatus amx_create_ioproc(AudioObjectID device, amx_processor *p, AudioDeviceIOProcID *out_id) {
    return AudioDeviceCreateIOProcID(device, amx_core_audio_ioproc, p, out_id);
}

OSStatus amx_create_recorder_ioproc(AudioObjectID device, amx_recorder *r, AudioDeviceIOProcID *out_id) {
    return AudioDeviceCreateIOProcID(device, amx_recorder_ioproc, r, out_id);
}

OSStatus amx_keep_trailing_input_streams(AudioObjectID device, AudioDeviceIOProcID proc, uint32_t keep_trailing) {
    AudioObjectPropertyAddress addr = {kAudioDevicePropertyIOProcStreamUsage, kAudioObjectPropertyScopeInput,
                                       kAudioObjectPropertyElementMain};
    UInt32 size = 0;
    OSStatus st = AudioObjectGetPropertyDataSize(device, &addr, 0, NULL, &size);
    if (st != noErr) return st;
    if (size < offsetof(AudioHardwareIOProcStreamUsage, mStreamIsOn)) return noErr;
    AudioHardwareIOProcStreamUsage *usage = (AudioHardwareIOProcStreamUsage *)calloc(1, size);
    if (!usage) return kAudioHardwareUnspecifiedError;
    usage->mIOProc = (void *)proc;
    st = AudioObjectGetPropertyData(device, &addr, 0, NULL, &size, usage);
    if (st == noErr) {
        const UInt32 n = usage->mNumberStreams;
        for (UInt32 i = 0; i < n; i++) usage->mStreamIsOn[i] = (i + keep_trailing >= n) ? 1u : 0u;
        st = AudioObjectSetPropertyData(device, &addr, 0, NULL, size, usage);
    }
    free(usage);
    return st;
}
#endif
