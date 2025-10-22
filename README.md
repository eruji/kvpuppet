# Karaoke Version - Track Downloader

This application automates the process of downloading individual tracks from your purchased songs on `karaoke-version.com`.

It logs in, navigates to the song page, and downloads each instrument track one by one into a dedicated folder on your computer.

## Prerequisites

Before you begin, you need to have **Node.js** installed on your computer. If you don't have it, you can download it from the official website:

- Download Node.js (The "LTS" version is recommended for most users).

## Getting Started

Follow these steps to set up and run the application.

### 1. Download the Project

Download the project files as a ZIP and extract them to a folder on your computer (e.g., on your Desktop).

### 2. Install Dependencies

Open your terminal or command prompt, navigate into the project folder, and run the following command. This will download and install all the necessary components for the application.

```bash
npm install
```

## How to Run the Application

Once the installation is complete, you can start the application from your terminal by running:

```bash
npm start
```

### First-Time Use

The first time you run the application, it will ask for your Karaoke-Version email and password. After you provide these, the application will create a `config.json` file to securely store these details for future use, so you won't have to enter them again.

### Using the Application

After logging in, you will be presented with a menu of your purchased songs:
-   **Select a song from the list:** Choose any of your purchased songs to download its tracks.
-   **Refresh song list:** If you've purchased new songs since starting the application, you can refresh the list.
-   **Enter a song URL manually:** If you prefer, you can still paste a direct URL to a song page.
-   **Exit:** Safely closes the application.

Downloaded songs will be saved in a `downloads` folder inside your project directory, with each song getting its own subfolder.

## Important Notes

- The `config.json` file contains your login credentials. **Do not share this file with anyone.**
- The application runs "headless" by default, meaning you won't see a browser window. It performs all actions in the background, and you will see the progress in your terminal.