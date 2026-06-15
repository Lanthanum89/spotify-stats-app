# SoundTracks: Spotify Stats App

SoundTracks is a locally hosted web application that connects to your Spotify account to display personalised listening statistics, top tracks, top artists, genre distributions, and recent listening history.

## Features

- **Profile Overview**: Displays user profile details, total playtime across recent tracks, and quick summaries.
- **Top Songs**: View your top 50 songs across three timeframes (4 weeks, 6 months, and all-time).
- **Top Artists**: View your top 50 artists with rankings, genres, and circle portraits.
- **Genre Distribution**: Calculates and visualises your top genres with a music taste classification profile.
- **Recently Played**: Shows your last 50 played tracks with relative time calculations and duration details.
- **Secure Architecture**: Kept local. Credentials and tokens are processed by a local Express server and stored only in your local session.

---

## Spotify API Setup Guide

To run this application, you must register a free application in the Spotify Developer Dashboard. Follow these steps:

1. **Access Developer Portal**:
   Go to the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) and log in using your standard Spotify credentials.

2. **Create App**:
   - Click the green **Create app** button in the top right.
   - Enter an **App name** (e.g. `SoundTracks Local`) and **App description**.
   - In the **Redirect URIs** field, enter: `http://127.0.0.1:3000/callback`
   - Select the **Web API** box under the API/SDK section.
   - Agree to the Developer Terms of Service and click **Save**.

3. **Retrieve Credentials**:
   - On your application's overview page, click the **Settings** button in the top right.
   - You will see your **Client ID**.
   - Click **View client secret** to show your **Client Secret**.
   - Keep this page open or copy these values, as you will need them in the next step.

---

## Running the Application

### 1. Configure Credentials
Duplicate the `.env.example` file in the root folder, rename the new file to `.env`, and fill in your details:
```env
SPOTIFY_CLIENT_ID=your_client_id_here
SPOTIFY_CLIENT_SECRET=your_client_secret_here
REDIRECT_URI=http://127.0.0.1:3000/callback
PORT=3000
SESSION_SECRET=select_a_long_random_string_here
```

### 2. Install Dependencies
Open your terminal in the application directory and run:
```bash
npm install
```

### 3. Run the Server
Start the local server using:
```bash
npm start
```

Once running, navigate to `http://127.0.0.1:3000` in your web browser, click **Connect with Spotify**, and authorise your application to view your stats.
