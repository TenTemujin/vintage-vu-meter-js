# Vintage VU Meter

![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)
![Built with Tauri](https://img.shields.io/badge/Built_with-Tauri-FFC131?logo=tauri&logoColor=white)

A desktop application that displays a real-time, vintage-style analog VU meter driven by your system's actual audio output — captured natively, with no screen-recording permission required.

***

## 💡 Features

-   **Native System Audio Capture**: Uses WASAPI loopback capture (Windows) to read the audio mix of a chosen output device directly — no window/screen picker, no screen-recording permission.
-   **Classic Analog Design**: Features a pivoting needle, a beige background, and a calibrated dBVU scale for a retro aesthetic.
-   **Device Selection**: A dropdown menu lists your actual audio output devices (not windows or screens).
-   **Always on Top**: A checkbox to pin the meter window on top of all other applications for continuous monitoring.

***

## 🚀 Getting Started

### Prerequisites

-   [Node.js](https://nodejs.org/) (includes npm).
-   [Rust](https://www.rust-lang.org/tools/install) (`cargo`/`rustc`).
-   Windows. Audio capture is implemented via WASAPI loopback and is Windows-only for now; on other platforms the app still runs but device capture returns an "unsupported" error.

### Installation

1.  Clone the repository:
    ```sh
    git clone [https://github.com/your-username/your-repository.git](https://github.com/your-username/your-repository.git)
    ```
2.  Navigate into the project directory:
    ```sh
    cd your-repository
    ```
3.  Install dependencies:
    ```sh
    npm install
    ```
4.  Start the app in development mode:
    ```sh
    npm run dev
    ```

***

## 🛠️ How to Use

-   **Select an Audio Device**: Use the dropdown menu to choose which output device to monitor (your default device is preselected). The needle reacts as soon as audio plays on that device.
-   **Always on Top**: Check the box to keep the VU meter window visible over all other windows.

***

## 🔬 Technical Details

-   **Tauri + Rust**: The app shell and native audio capture run in a small Rust backend, avoiding the overhead and permission model of a full browser engine.
-   **`wasapi` crate**: Opens the selected output device's WASAPI client in loopback mode and streams computed dBFS levels to the UI over a Tauri IPC `Channel`.
-   **HTML `<canvas>`**: Used to draw and animate the vintage-style VU meter interface. The static bezel/face/scale artwork is cached to an offscreen canvas and only redrawn on resize; each animation frame only repaints the needle, peak light, and dB readout.

### File Structure

-   `src-tauri/src/main.rs`: Registers Tauri commands, creates the window.
-   `src-tauri/src/audio.rs`: Device enumeration and WASAPI loopback capture, with dBFS level computation.
-   `index.html`: The UI structure.
-   `renderer.js`: UI logic, device selection, and all canvas drawing/animation.
-   `styles.css`: Chassis and control styling.

***

## 📄 License

This project is licensed under the MIT License. See the `LICENSE` file for details.
