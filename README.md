# Vintage VU Meter

![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)
![Built with Electron](https://img.shields.io/badge/Built_with-Electron-47848F?logo=electron&logoColor=white)

A cross-platform desktop application that displays a real-time, vintage-style analog VU meter for your system's audio output.

***

## 💡 Features

-   **Real-time Audio Visualization**: Renders an audio meter that reacts to the sound currently playing on your computer.
-   **Classic Analog Design**: Features a pivoting needle, a beige background, and a calibrated dBVU scale for a retro aesthetic.
-   **Source Selection**: A dropdown menu allows you to select which screen or application window to capture audio from.
-   **Always on Top**: A checkbox to pin the meter window on top of all other applications for continuous monitoring.
-   **Cross-Platform**: Built with Electron, it works on Windows, macOS, and Linux.

***

## 🚀 Getting Started

To run this application in your development environment, follow these steps.

### Prerequisites

-   [Node.js](https://nodejs.org/) (which includes npm) installed on your system.

### Installation

1.  Clone the repository to your local machine:
    ```sh
    git clone [https://github.com/your-username/your-repository.git](https://github.com/your-username/your-repository.git)
    ```
2.  Navigate into the project directory:
    ```sh
    cd your-repository
    ```
3.  Install all project dependencies:
    ```sh
    npm install
    ```
4.  Start the application:
    ```sh
    npm start
    ```

***

## 🛠️ How to Use

### ⚠️ Important: Granting Permissions

To capture system audio, the application needs **Screen Recording** permissions. Modern operating systems require you to grant this manually.

**On macOS:**
1.  Open **System Settings**.
2.  Go to **Privacy & Security** > **Screen Recording**.
3.  Find your terminal application (e.g., `Terminal`, `iTerm`, `Visual Studio Code`) in the list and **enable the toggle switch**.
4.  The OS will prompt you to **Quit & Reopen** the application. **This step is crucial.**
5.  After reopening, run `npm start` again.

**On Windows / Linux:**
Permissions are generally less strict. However, ensure no third-party security software is blocking the application.

### Application Features

-   **Select an Audio Source**: Use the dropdown menu to choose which screen or window you want to monitor. The needle will begin moving as soon as audio is detected from the selected source.
-   **Always on Top**: Check the box to keep the VU meter window visible over all other windows.

***

## 🔬 Technical Details

This application demonstrates how to integrate various web technologies to create a useful desktop utility:

-   **Electron**: The core framework for building the cross-platform desktop app with JavaScript, HTML, and CSS.
-   **Electron `desktopCapturer` API**: Used to safely get a list of available media sources (screens and windows).
-   **Web Audio API**: Once a media source is captured, the Web Audio API (`AudioContext`, `AnalyserNode`) is used to analyze the audio data in real-time.
-   **HTML `<canvas>`**: Used to draw and animate the vintage-style VU meter interface, updating on every frame with `requestAnimationFrame`.

### File Structure

-   `main.js`: The Electron main process. It creates the application window, handles system events, and fetches the audio sources.
-   `preload.js`: A secure bridge script that exposes specific Node.js/Electron functionalities to the renderer process in a controlled way.
-   `index.html`: The User Interface (UI) structure of the application.
-   `renderer.js`: The Electron renderer process. It handles the UI logic, user interaction, and all the animation drawing on the canvas.

***

## 📄 License

This project is licensed under the MIT License. See the `LICENSE` file for details.
