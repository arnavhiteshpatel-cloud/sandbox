import AirMixAudio
import AirMixCore
import AppKit
import SwiftUI

struct EQSectionView: View {
    @EnvironmentObject var model: AppModel
    @ObservedObject var engine: AudioEngine
    @State var selectedBand: UUID?
    @State var savingPreset = false
    @State var presetName = ""

    private var appID: String? { model.selectedAppID ?? model.rows.first?.id }

    var body: some View {
        Page(title: "Equalizer", subtitle: "Shape each app’s sound. Drag the points; changes are heard immediately.",
             trailing: AnyView(appPicker)) {
            if let id = appID {
                editor(for: id)
            } else {
                EmptyMixer().frame(maxWidth: .infinity)
            }
        }
    }

    private var appPicker: some View {
        Menu {
            ForEach(model.rows) { row in
                Button {
                    model.selectedAppID = row.id
                    selectedBand = nil
                } label: {
                    Label(row.name, systemImage: row.id == appID ? "checkmark" : row.category.symbolName)
                }
            }
        } label: {
            HStack(spacing: 6) {
                if let id = appID, let row = model.rows.first(where: { $0.id == id }) {
                    AppIconView(id: row.id, bundlePath: row.bundlePath, category: row.category, size: 18)
                    Text(row.name).font(.system(size: 13, weight: .medium))
                } else {
                    Text("Choose an app")
                }
                Image(systemName: "chevron.up.chevron.down").font(.system(size: 9, weight: .bold)).foregroundStyle(.secondary)
            }
            .padding(.horizontal, 10).padding(.vertical, 5)
            .background(Capsule().fill(Theme.track))
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
    }

    @ViewBuilder private func editor(for id: String) -> some View {
        let eq = model.appSettings(id).eq
        let binding = Binding<EQSettings>(get: { model.appSettings(id).eq }, set: { model.setEQ(id, $0) })
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 12) {
                Toggle(isOn: Binding(get: { eq.isEnabled }, set: { v in var e = eq; e.isEnabled = v; model.setEQ(id, e) })) {
                    Text(eq.isEnabled ? "EQ On" : "Bypassed").font(.system(size: 12, weight: .semibold))
                }
                .toggleStyle(.switch)
                .controlSize(.small)
                .help("Bypass switches instantly with a short crossfade")

                Menu {
                    ForEach(EQPreset.builtIn) { p in Button(p.name) { model.applyPreset(p.id, to: id) } }
                    if !model.settings.customPresets.isEmpty {
                        Divider()
                        ForEach(model.settings.customPresets) { p in Button(p.name) { model.applyPreset(p.id, to: id) } }
                        Divider()
                        Menu("Delete Custom Preset") {
                            ForEach(model.settings.customPresets) { p in Button(p.name) { model.deleteCustomPreset(p.id) } }
                        }
                    }
                } label: {
                    Label(eq.presetID.flatMap { model.settings.preset(id: $0)?.name } ?? "Custom", systemImage: "list.bullet")
                        .font(.system(size: 12))
                }
                .fixedSize()

                Button("Save Preset…") { presetName = ""; savingPreset = true }
                    .controlSize(.small)
                Button("Reset to Flat") {
                    var e = eq
                    e.bands = EQSettings.defaultBands()
                    e.presetID = "flat"
                    model.setEQ(id, e)
                }
                .controlSize(.small)
                Spacer()
                Toggle("Auto headroom", isOn: Binding(get: { eq.autoHeadroom }, set: { v in var e = eq; e.autoHeadroom = v; model.setEQ(id, e) }))
                    .toggleStyle(.checkbox)
                    .font(.system(size: 11))
                    .help("Lowers the level by the curve’s largest boost so the EQ can never clip.")
            }
            .padding(.horizontal, 28)

            EQGraph(eq: binding, selectedBand: $selectedBand, meter: engine.isProcessing(id) ? engine.meters.model(for: id) : nil)
                .frame(minHeight: 260, maxHeight: 340)
                .padding(.horizontal, 28)
                .opacity(eq.isEnabled ? 1 : 0.55)

            BandStrip(eq: binding, selectedBand: $selectedBand)
                .padding(.horizontal, 28)
                .padding(.bottom, 20)
        }
        .sheet(isPresented: $savingPreset) {
            VStack(alignment: .leading, spacing: 12) {
                Text("Save EQ Preset").font(.headline)
                TextField("Preset name", text: $presetName).textFieldStyle(.roundedBorder).frame(width: 260)
                HStack {
                    Spacer()
                    Button("Cancel") { savingPreset = false }
                    Button("Save") {
                        let p = model.saveCustomPreset(name: presetName.isEmpty ? "My Preset" : presetName, bands: eq.bands)
                        var e = eq; e.presetID = p.id; model.setEQ(id, e)
                        savingPreset = false
                    }
                    .keyboardShortcut(.defaultAction)
                }
            }
            .padding(20)
        }
    }
}

/// Frequency-response graph with draggable band nodes.
struct EQGraph: View {
    @Binding var eq: EQSettings
    @Binding var selectedBand: UUID?
    var meter: MeterModel?
    private let dbRange: Double = 15

    var body: some View {
        GeometryReader { geo in
            let size = geo.size
            ZStack {
                RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Color.black.opacity(0.18))
                Canvas { ctx, sz in
                    drawGrid(ctx, sz)
                    drawResponse(ctx, sz)
                }
                ForEach(eq.bands) { band in
                    let p = point(for: band, in: size)
                    BandNode(band: band, selected: selectedBand == band.id)
                        .position(p)
                        .gesture(DragGesture(minimumDistance: 0)
                            .onChanged { g in
                                selectedBand = band.id
                                guard let i = eq.bands.firstIndex(where: { $0.id == band.id }) else { return }
                                var b = eq.bands[i]
                                b.frequency = frequency(atX: g.location.x, width: size.width).clamped(to: EQBand.frequencyRange)
                                if b.type.usesGain {
                                    b.gainDB = ((gain(atY: g.location.y, height: size.height) * 2).rounded() / 2)
                                        .clamped(to: EQBand.gainRange)
                                }
                                b.isEnabled = true
                                eq.bands[i] = b
                                eq.presetID = nil
                            })
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Theme.cardStroke, lineWidth: 0.5))
        }
    }

    private func x(for f: Double, width: CGFloat) -> CGFloat {
        CGFloat((log10(f) - log10(20)) / (log10(20000) - log10(20))) * width
    }

    private func frequency(atX x: CGFloat, width: CGFloat) -> Double {
        pow(10, log10(20) + Double(x / width) * (log10(20000) - log10(20)))
    }

    private func y(for db: Double, height: CGFloat) -> CGFloat {
        CGFloat(0.5 - db / (2 * dbRange)) * height
    }

    private func gain(atY y: CGFloat, height: CGFloat) -> Double {
        (0.5 - Double(y / height)) * 2 * dbRange
    }

    private func point(for band: EQBand, in size: CGSize) -> CGPoint {
        let db = band.type.usesGain ? band.gainDB : EQDesigner.bandResponse(band, frequencies: [band.frequency])[0]
        return CGPoint(x: x(for: band.frequency, width: size.width), y: y(for: db.clamped(to: -dbRange...dbRange), height: size.height))
    }

    private func drawGrid(_ ctx: GraphicsContext, _ size: CGSize) {
        let line = Color.primary.opacity(0.08)
        for f in [50.0, 100, 200, 500, 1000, 2000, 5000, 10000] {
            let xx = x(for: f, width: size.width)
            var p = Path(); p.move(to: CGPoint(x: xx, y: 0)); p.addLine(to: CGPoint(x: xx, y: size.height))
            ctx.stroke(p, with: .color(line), lineWidth: 0.5)
            let label = f >= 1000 ? "\(Int(f / 1000))k" : "\(Int(f))"
            ctx.draw(Text(label).font(.system(size: 9, weight: .medium)).foregroundColor(.secondary),
                     at: CGPoint(x: xx, y: size.height - 9))
        }
        for db in stride(from: -12.0, through: 12, by: 6) {
            let yy = y(for: db, height: size.height)
            var p = Path(); p.move(to: CGPoint(x: 0, y: yy)); p.addLine(to: CGPoint(x: size.width, y: yy))
            ctx.stroke(p, with: .color(db == 0 ? Color.primary.opacity(0.2) : line), lineWidth: db == 0 ? 1 : 0.5)
            ctx.draw(Text(db > 0 ? "+\(Int(db))" : "\(Int(db))").font(.system(size: 9, weight: .medium)).foregroundColor(.secondary),
                     at: CGPoint(x: 16, y: yy - 7))
        }
    }

    private func drawResponse(_ ctx: GraphicsContext, _ size: CGSize) {
        let n = max(64, Int(size.width / 3))
        let freqs = EQDesigner.logFrequencies(count: n)
        var shown = eq
        shown.isEnabled = true
        let response = EQDesigner.response(shown, frequencies: freqs)
        var curve = Path()
        for (i, f) in freqs.enumerated() {
            let p = CGPoint(x: x(for: f, width: size.width), y: y(for: response[i].clamped(to: -dbRange...dbRange), height: size.height))
            if i == 0 { curve.move(to: p) } else { curve.addLine(to: p) }
        }
        var fill = curve
        let zero = y(for: 0, height: size.height)
        fill.addLine(to: CGPoint(x: size.width, y: zero))
        fill.addLine(to: CGPoint(x: 0, y: zero))
        fill.closeSubpath()
        ctx.fill(fill, with: .linearGradient(Gradient(colors: [Theme.accent.opacity(0.32), Theme.accent2.opacity(0.06)]),
                                            startPoint: CGPoint(x: 0, y: 0), endPoint: CGPoint(x: 0, y: size.height)))
        ctx.stroke(curve, with: .linearGradient(Gradient(colors: [Theme.accent, Theme.accent2]),
                                               startPoint: .zero, endPoint: CGPoint(x: size.width, y: 0)),
                   style: StrokeStyle(lineWidth: 2.2, lineCap: .round, lineJoin: .round))
        if let sel = eq.bands.first(where: { $0.id == selectedBand }) {
            let r = EQDesigner.bandResponse(sel, frequencies: freqs)
            var bp = Path()
            for (i, f) in freqs.enumerated() {
                let p = CGPoint(x: x(for: f, width: size.width), y: y(for: r[i].clamped(to: -dbRange...dbRange), height: size.height))
                if i == 0 { bp.move(to: p) } else { bp.addLine(to: p) }
            }
            ctx.stroke(bp, with: .color(Color.primary.opacity(0.35)), style: StrokeStyle(lineWidth: 1, dash: [3, 3]))
        }
    }
}

private struct BandNode: View {
    let band: EQBand
    let selected: Bool

    var body: some View {
        ZStack {
            Circle().fill(selected ? Theme.accent : Color.white.opacity(band.isEnabled ? 0.92 : 0.35))
            Circle().strokeBorder(Theme.accent.opacity(selected ? 1 : 0.6), lineWidth: 2)
        }
        .frame(width: selected ? 16 : 13, height: selected ? 16 : 13)
        .shadow(color: .black.opacity(0.4), radius: 2, y: 1)
        .contentShape(Circle().inset(by: -8))
        .animation(.easeOut(duration: 0.12), value: selected)
    }
}

/// Row of band cards with precise controls.
struct BandStrip: View {
    @Binding var eq: EQSettings
    @Binding var selectedBand: UUID?

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(eq.bands) { band in
                    bandCard(band)
                }
                if eq.bands.count < 12 {
                    Button {
                        var b = EQBand(frequency: 3000)
                        b.q = 1
                        eq.bands.append(b)
                        selectedBand = b.id
                        eq.presetID = nil
                    } label: {
                        Image(systemName: "plus").font(.system(size: 14, weight: .semibold))
                            .frame(width: 40, height: 120)
                            .background(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.cardStroke, style: StrokeStyle(lineWidth: 1, dash: [4, 3])))
                    }
                    .buttonStyle(.plain)
                    .help("Add band")
                }
            }
        }
    }

    /// Applies a change to the band with this id (looked up fresh, so edits never hit a stale index).
    private func edit(_ id: UUID, _ change: (inout EQBand) -> Void) {
        guard let i = eq.bands.firstIndex(where: { $0.id == id }) else { return }
        change(&eq.bands[i])
        eq.presetID = nil
    }

    private func bandCard(_ band: EQBand) -> some View {
        let selected = selectedBand == band.id
        let id = band.id
        return VStack(alignment: .leading, spacing: 6) {
            HStack {
                Picker("", selection: Binding(get: { band.type }, set: { v in edit(id) { $0.type = v } })) {
                    ForEach(FilterType.allCases, id: \.self) { Text($0.displayName).tag($0) }
                }
                .labelsHidden()
                .controlSize(.mini)
                .frame(width: 84)
                Spacer(minLength: 0)
                Toggle("", isOn: Binding(get: { band.isEnabled }, set: { v in edit(id) { $0.isEnabled = v } }))
                    .toggleStyle(.switch).controlSize(.mini).labelsHidden()
            }
            field("Hz", value: Binding(get: { band.frequency },
                                       set: { v in edit(id) { $0.frequency = v.clamped(to: EQBand.frequencyRange) } }),
                  digits: 0)
            field("dB", value: Binding(get: { band.gainDB },
                                       set: { v in edit(id) { $0.gainDB = v.clamped(to: EQBand.gainRange) } }),
                  digits: 1)
                .disabled(!band.type.usesGain)
            field("Q", value: Binding(get: { band.q }, set: { v in edit(id) { $0.q = v.clamped(to: EQBand.qRange) } }),
                  digits: 2)
            if eq.bands.count > 1 {
                Button("Remove") {
                    eq.bands.removeAll { $0.id == id }
                    eq.presetID = nil
                    if selectedBand == id { selectedBand = nil }
                }
                .buttonStyle(.borderless)
                .font(.system(size: 10))
                .foregroundStyle(.secondary)
            }
        }
        .padding(8)
        .frame(width: 128)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(selected ? Theme.accent.opacity(0.12) : Theme.cardFill))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(selected ? Theme.accent.opacity(0.5) : Theme.cardStroke, lineWidth: 0.5))
        .onTapGesture { selectedBand = id }
    }

    private func field(_ label: String, value: Binding<Double>, digits: Int) -> some View {
        HStack(spacing: 4) {
            Text(label).font(.system(size: 10)).foregroundStyle(.secondary).frame(width: 18, alignment: .leading)
            TextField("", value: value, format: .number.precision(.fractionLength(digits)))
                .textFieldStyle(.roundedBorder)
                .controlSize(.mini)
                .font(Theme.mono(10))
        }
    }
}
