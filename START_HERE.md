# Start here: getting JARVIS running on your Mac

Total time: about 30–60 minutes, mostly downloads. You need an internet connection only for this setup.

## 1. Open Terminal
Press **⌘ Space**, type **Terminal**, press **Return**.

## 2. Install Homebrew (skip if `brew --version` already works)
```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```
It asks for your Mac password and installs Apple's Command Line Tools too. When it finishes it prints two
"Next steps" commands (`echo … >> ~/.zprofile` and `eval …`). **Run those two lines**, then check:
```bash
brew --version
```

## 3. Download JARVIS
```bash
git clone --branch claude/project-jarvis-ai-assistant-rddtrw https://github.com/arnavhiteshpatel-cloud/sandbox.git ~/JARVIS
```

## 4. Install (builds the app and downloads the models, about 10 GB)
```bash
cd ~/JARVIS && ./scripts/install.sh
```
It installs `uv` and Ollama, builds `JARVIS.app` and copies it to /Applications. Then it downloads the models, checks your Mac,
and opens JARVIS. If the Swift build stops with a compiler error, copy the error into a Claude Code session opened in `~/JARVIS`;
that part could not be compiled before reaching your Mac.

## 5. Grant permissions (first launch)
JARVIS opens **Settings → Permissions**. Allow each when macOS asks, or turn them on in
**System Settings → Privacy & Security**:
- **Microphone**: listening.
- **Accessibility**: clicking and typing in apps, **and the ⌥⇧C talk key**. Until this is granted, the talk key is ⌃⌥C.
- **Screen & System Audio Recording**: "what's on my screen".
- **Automation**: click **Allow** when asked "JARVIS wants to control Arc" (and Finder, System Events).

Then **quit and reopen JARVIS** (menu-bar icon → right-click → Quit JARVIS; open it from Applications) so ⌥⇧C activates.

## 6. Start at login
Right-click the menu-bar icon → **Launch at Login**.

## 7. Make your "open my IB" shortcut
Open your IB course page in Arc, then hold **⌥⇧C** and say: *"Create a shortcut called open my IB."*
When it asks what the shortcut should do, hold ⌥⇧C again and say *"Open Arc and go to this URL."* Then say *"yes."*
(Or: menu-bar icon → Command Center → Shortcuts → New → paste the URL.)

## 8. Try it
Hold **⌥⇧C**, speak, then release:
- "Open Spotify."
- "Open my IB." → "Go to the assignments." → "Open the most recent one." → "Read the instructions and tell me what I need to do."
- "What's my battery?" · "Remember that I prefer Arc for school websites."

When plugged in, you can also just say **"Hey JARVIS"**. **⌃⌥⌘.** (Ctrl+Option+Cmd+Period) stops everything.

## 9. Verify and record results (optional, recommended)
```bash
/Applications/JARVIS.app/Contents/Resources/python/bin/python3 -m jarvis.acceptance
```

## If something goes wrong
- Logs: `~/Library/Logs/JARVIS/`
- Check everything:
  ```bash
  /Applications/JARVIS.app/Contents/Resources/python/bin/python3 -m jarvis doctor
  ```
- "Can't reach my local AI model": open the **Ollama** app.
