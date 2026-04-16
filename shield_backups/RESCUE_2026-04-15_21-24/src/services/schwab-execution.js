import axios from 'axios';
import fs from 'fs';
import path from 'path';

/**
 * Charles Schwab API Execution Engine
 * Handles OAuth 2.0 flow, token refreshing, and placing complex Option/Equity limit orders.
 */
class SchwabExecutionService {
    constructor() {
        this.clientId = process.env.SCHWAB_CLIENT_ID || '';
        this.clientSecret = process.env.SCHWAB_CLIENT_SECRET || '';
        this.redirectUri = process.env.SCHWAB_REDIRECT_URI || 'https://127.0.0.1';
        
        // Schwab's OAuth base URL for individual developers
        this.authBaseUrl = 'https://api.schwabapi.com/v1/oauth';
        this.baseApiUrl = 'https://api.schwabapi.com/trader/v1';

        this.accessToken = null;
        this.refreshToken = null;
        this.tokenExpiry = null;

        this.tokenPath = path.join(process.cwd(), '.schwab_tokens.json');
        this.loadTokens();
    }

    /**
     * Step 1: Generate the Authorization URL for the user to click.
     */
    getAuthorizationUrl() {
        if (!this.clientId) return "ERROR: Missing SCHWAB_CLIENT_ID in .env";
        return `${this.authBaseUrl}/authorize?client_id=${this.clientId}&redirect_uri=${encodeURIComponent(this.redirectUri)}&response_type=code`;
    }

    /**
     * Step 2: Exchange the authorization code for Access & Refresh tokens.
     */
    async generateTokensFromCode(authCode) {
        try {
            const credentials = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
            const data = `grant_type=authorization_code&code=${authCode}&redirect_uri=${encodeURIComponent(this.redirectUri)}`;

            const response = await axios.post(`${this.authBaseUrl}/token`, data, {
                headers: {
                    'Authorization': `Basic ${credentials}`,
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            });

            this.saveTokens(response.data);
            return { success: true, message: 'Tokens successfully generated and saved!' };
        } catch (error) {
            console.error('[SCHWAB] Token Generation Failed:', error.response?.data || error.message);
            return { success: false, error: error.response?.data || error.message };
        }
    }

    /**
     * Step 3: Refresh the Access Token (Valid for 30 minutes, Refresh Token valid for 7 days).
     */
    async refreshAccessToken() {
        if (!this.refreshToken) throw new Error("No refresh token available. Must authenticate first.");

        try {
            const credentials = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
            const data = `grant_type=refresh_token&refresh_token=${this.refreshToken}`;

            const response = await axios.post(`${this.authBaseUrl}/token`, data, {
                headers: {
                    'Authorization': `Basic ${credentials}`,
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            });

            // Schwab API replaces the access token but keeps the existing refresh token lifetime
            this.saveTokens(response.data);
            return true;
        } catch (error) {
            console.error('[SCHWAB] Token Refresh Failed:', error.response?.data || error.message);
            // If refresh fails (expired after 7 days), we wipe tokens and require manual re-auth
            this.wipeTokens();
            return false;
        }
    }

    /**
     * Ensures the token is valid before making any API calls.
     */
    async ensureAuthenticated() {
        if (!this.accessToken) {
            throw new Error("Schwab API is not authenticated. Please run the OAuth flow.");
        }
        
        // Refresh token proactively if it expires in less than 2 minutes
        if (this.tokenExpiry && Date.now() >= (this.tokenExpiry - 120000)) {
            console.log("[SCHWAB] Access token almost expired. Refreshing...");
            const success = await this.refreshAccessToken();
            if (!success) throw new Error("Failed to refresh token. Manual re-authentication required.");
        }
    }

    /**
     * API Call: Get User Account Numbers & Hashes
     * (Schwab requires an Account Hash to place orders, not the raw account number)
     */
    async getAccountNumbers() {
        await this.ensureAuthenticated();
        try {
            const response = await axios.get(`${this.baseApiUrl}/accounts/accountNumbers`, {
                headers: { 'Authorization': `Bearer ${this.accessToken}` }
            });
            return response.data; // Returns [{ accountNumber, hashValue }]
        } catch (error) {
            console.error('[SCHWAB] Get Accounts Failed:', error.response?.data || error.message);
            throw error;
        }
    }

    /**
     * Generic API Wrapper
     */
    async get(endpoint) {
        await this.ensureAuthenticated();
        const response = await axios.get(`${this.baseApiUrl}${endpoint}`, {
            headers: { 'Authorization': `Bearer ${this.accessToken}` }
        });
        return response.data;
    }

    async post(endpoint, data) {
        await this.ensureAuthenticated();
        const response = await axios.post(`${this.baseApiUrl}${endpoint}`, data, {
            headers: { 
                'Authorization': `Bearer ${this.accessToken}`,
                'Content-Type': 'application/json'
            }
        });
        return response.data;
    }

    // ─── FILE SYSTEM TOKEN MANAGEMENT ────────────────────────────────────────

    saveTokens(tokenData) {
        this.accessToken = tokenData.access_token;
        if (tokenData.refresh_token) {
            this.refreshToken = tokenData.refresh_token; 
        }
        // Token expires in usually 1800 seconds (30 mins)
        const expiresIn = tokenData.expires_in || 1800;
        this.tokenExpiry = Date.now() + (expiresIn * 1000);

        const dataToSave = {
            access_token: this.accessToken,
            refresh_token: this.refreshToken,
            token_expiry: this.tokenExpiry
        };
        fs.writeFileSync(this.tokenPath, JSON.stringify(dataToSave, null, 2));
        console.log(`[SCHWAB] Tokens securely saved to ${this.tokenPath}`);
    }

    loadTokens() {
        if (fs.existsSync(this.tokenPath)) {
            try {
                const data = JSON.parse(fs.readFileSync(this.tokenPath, 'utf8'));
                this.accessToken = data.access_token;
                this.refreshToken = data.refresh_token;
                this.tokenExpiry = data.token_expiry;
                console.log("[SCHWAB] Cached authentication tokens loaded.");
            } catch (e) {
                console.warn("[SCHWAB] Could not parse cached tokens.");
            }
        }
    }

    wipeTokens() {
        this.accessToken = null;
        this.refreshToken = null;
        this.tokenExpiry = null;
        if (fs.existsSync(this.tokenPath)) fs.unlinkSync(this.tokenPath);
        console.warn("[SCHWAB] Authentication tokens wiped.");
    }
}

export const schwabApi = new SchwabExecutionService();
