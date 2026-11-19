// AirMixDSP — real-time safe audio processing kernel for AirMix.
//
// Everything that runs on the Core Audio I/O thread lives in this C module:
//   * no memory allocation, no locks, no Objective-C/Swift runtime calls
//   * parameters are handed over with C11 atomics (relaxed/acq-rel)
//   * EQ coefficient sets are handed over through a wait-free triple buffer
//
// The control side (Swift) owns an amx_processor, sets parameters from a single
// thread (the main thread) and polls meters at UI rate.

#ifndef AIRMIX_DSP_H
#define AIRMIX_DSP_H

#include <stdint.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

#define AMX_MAX_BANDS 12
#define AMX_MAX_CHUNK 4096

/// Normalised biquad coefficients (a0 == 1), Direct Form II transposed.
typedef struct {
    double b0, b1, b2, a1, a2;
} amx_biquad;

/// Mirror of Core Audio's AudioBuffer (identical layout, verified by static asserts on Apple).
typedef struct {
    uint32_t channels;
    uint32_t byte_size;
    void *data;
} amx_buffer;

typedef struct amx_processor amx_processor;

/// Meter values published by the audio thread.
typedef struct {
    float peak_left;        ///< post-processing peak (linear) since last read
    float peak_right;
    float input_rms;        ///< smoothed pre-gain RMS (linear, both channels) — used for ducking triggers
    float voice_ratio;      ///< smoothed share of energy in the 300–3400 Hz voice band (0…1), if enabled
    uint32_t clip_events;   ///< samples the limiter had to catch since last read
    uint64_t frames;        ///< total frames processed (monotonic)
    uint32_t callbacks;     ///< total I/O callbacks (monotonic)
    float current_gain;     ///< gain currently applied (after smoothing)
} amx_meters;

// ---- lifecycle (control thread) ----
amx_processor *amx_processor_create(double sample_rate);
void amx_processor_destroy(amx_processor *p);

/// Changes the sample rate used for smoothing/voice detection. Only call while the I/O proc is stopped.
void amx_processor_set_sample_rate(amx_processor *p, double sample_rate);
double amx_processor_sample_rate(const amx_processor *p);

// ---- parameters (control thread, lock-free) ----
/// Target linear gain (volume × mute × ducking × boost). Smoothed per sample on the audio thread.
void amx_set_gain(amx_processor *p, float linear_gain);
/// Jump to the target gain without a ramp (use before starting I/O).
void amx_set_gain_immediate(amx_processor *p, float linear_gain);
/// Gain smoothing time constant in milliseconds (default 12 ms).
void amx_set_gain_smoothing_ms(amx_processor *p, float ms);
/// Publishes a new EQ (bands are copied). count is clamped to AMX_MAX_BANDS. preamp is linear.
void amx_set_eq(amx_processor *p, const amx_biquad *bands, int count, float preamp_linear);
/// Enables/disables the EQ with a short crossfade (no clicks).
void amx_set_eq_enabled(amx_processor *p, bool enabled);
/// Brick-wall peak limiter that prevents output above `ceiling` (linear). Default on, 0.98.
void amx_set_limiter(amx_processor *p, bool enabled, float ceiling);
/// Enables the voice-band energy detector (costs two biquads per sample).
void amx_set_voice_detection(amx_processor *p, bool enabled);
/// Which input buffer holds the tapped audio (-1 = last non-empty buffer) and the channel offset in it.
void amx_set_input_layout(amx_processor *p, int buffer_index, int channel_offset);

// ---- meters (any non-RT thread) ----
/// Reads meters; peaks and clip counters are reset by the read.
void amx_read_meters(amx_processor *p, amx_meters *out);

// ---- processing (audio thread) ----
/// Processes planar stereo audio. In-place operation (in == out) is allowed.
void amx_process_stereo(amx_processor *p, const float *in_l, const float *in_r,
                        float *out_l, float *out_r, uint32_t frames);

/// Processes Core-Audio-style buffer lists (interleaved Float32 per buffer).
/// Reads stereo from the configured input buffer and writes to the first output buffer's first
/// two channels; every other output channel/buffer is zeroed. Missing input produces silence.
void amx_process_buffers(amx_processor *p, const amx_buffer *in, uint32_t in_count,
                         amx_buffer *out, uint32_t out_count);

// ---- filter design helpers (control thread; also used by tests) ----
typedef enum {
    AMX_PEAKING = 0,
    AMX_LOW_SHELF = 1,
    AMX_HIGH_SHELF = 2,
    AMX_LOW_PASS = 3,
    AMX_HIGH_PASS = 4,
    AMX_NOTCH = 5,
    AMX_BAND_PASS = 6,
} amx_filter_type;

/// RBJ "Audio EQ Cookbook" designs. Frequency is clamped to (1 Hz, 0.49·fs).
amx_biquad amx_design(amx_filter_type type, double sample_rate, double frequency, double q, double gain_db);
/// Magnitude response in dB of a cascade at `frequency`.
double amx_cascade_magnitude_db(const amx_biquad *bands, int count, double sample_rate, double frequency);

#ifdef __APPLE__
#include <CoreAudio/CoreAudio.h>
/// Core Audio I/O proc. Pass the amx_processor pointer as client data.
OSStatus amx_core_audio_ioproc(AudioObjectID device,
                               const AudioTimeStamp *now,
                               const AudioBufferList *input_data,
                               const AudioTimeStamp *input_time,
                               AudioBufferList *output_data,
                               const AudioTimeStamp *output_time,
                               void *client_data);
#endif

#ifdef __cplusplus
}
#endif

#endif // AIRMIX_DSP_H
