        fs.mkdirSync(sessionPath, { recursive: true });
      }

      const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
      const { version } = await fetchLatestBaileysVersion();

      if (royalActiveSockets[uniqueKey]) {
        try {
          royalActiveSockets[uniqueKey].ev.removeAllListeners();
          royalActiveSockets[uniqueKey].end();
          delete royalActiveSockets[uniqueKey];
        } catch (e) {}
      }

      const RoyalKing = makeWASocket({
        version,
        logger: pino.default({ level: 'fatal' }),
        browser: ["Ubuntu", "Chrome", "110.0.5481.77"],
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, pino.default({ level: 'fatal' }))
        },
        printQRInTerminal: false,
        markOnlineOnConnect: true,
        connectTimeoutMs: 120000,
        keepAliveIntervalMs: 10000,
        getMessage: async () => undefined,
      });

      royalActiveSockets[uniqueKey] = RoyalKing;

      if (!RoyalKing.authState.creds.registered && sendPairingCode && royalConnectionStates[uniqueKey] !== RoyalSessionState.PAIRED) {
        await new Promise(resolve => setTimeout(resolve, 3000));
        try {
          const cleanedNumber = phoneNumber.replace(/[^0-9]/g, '');
          const code = await RoyalKing.requestPairingCode(cleanedNumber);
          const pairingCode = code?.match(/.{1,4}/g)?.join('-') || code;
          if (!pairingCodeSent) {
            pairingCodeSent = true;
            sendPairingCode(pairingCode, false);
          }
        } catch (error) {
          console.error(chalk.red(`❌ Pairing error: ${error.message}`));
        }
      }

      RoyalKing.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === "open") {
          console.log(chalk.green(`\n✅ WhatsApp Connected! (${phoneNumber}) ✅\n`));
          royalConnectionStates[uniqueKey] = RoyalSessionState.CONNECTED;
          royalReconnectAttempts[uniqueKey] = 0;
          
          royalHeroesSessions[uniqueKey] = { 
            ...royalHeroesSessions[uniqueKey],
            phoneNumber, 
            uniqueKey,
            connected: true,
            lastUpdateTimestamp: Date.now() 
          };
          royalSaveSessions();

          if (sendPairingCode && !pairingCodeSent) {
            pairingCodeSent = true;
            sendPairingCode(null, true);
          }

          if (royalHeroesSessions[uniqueKey]?.messaging && royalHeroesSessions[uniqueKey]?.messages) {
            royalStartMessaging(RoyalKing, uniqueKey, royalHeroesSessions[uniqueKey].target, royalHeroesSessions[uniqueKey].hatersName, royalHeroesSessions[uniqueKey].messages, royalHeroesSessions[uniqueKey].speed);
          }
        }

        if (connection === "close") {
          const statusCode = (lastDisconnect?.error instanceof Boom) ? lastDisconnect.error.output.statusCode : 0;
          let shouldReconnect = true;
          
          if (statusCode === DisconnectReason.loggedOut) {
            console.log(chalk.bold.red(`🚨 LoggedOut (401) for ${phoneNumber}. Checking persistence...`));
            if (!fs.existsSync(path.join(sessionPath, 'creds.json'))) {
              shouldReconnect = false;
            }
          }

          console.log(chalk.red(`⚠️ Connection closed. Status: ${statusCode}. Reconnecting: ${shouldReconnect}`));
          
          if (shouldReconnect && royalConnectionStates[uniqueKey] !== RoyalSessionState.STOPPED) {
            royalConnectionStates[uniqueKey] = RoyalSessionState.RECONNECTING;
            delete royalActiveSockets[uniqueKey];
            if (royalStopFlags[uniqueKey]?.timeout) clearTimeout(royalStopFlags[uniqueKey].timeout);
            
            const delay = Math.min(2000 * (royalReconnectAttempts[uniqueKey] || 1), 30000);
            royalReconnectAttempts[uniqueKey] = (royalReconnectAttempts[uniqueKey] || 0) + 1;
            setTimeout(() => royalStartConnection(), delay);
          }
        }
      });

      RoyalKing.ev.on('creds.update', saveCreds);

    } catch (error) {
      console.error(chalk.red(`❌ Connection Error: ${error.message}`));
      if (royalConnectionStates[uniqueKey] !== RoyalSessionState.STOPPED) {
        setTimeout(() => royalStartConnection(), 5000);
      }
    }
  };

  await royalStartConnection();
};

const royalRestoreSessions = async () => {
  if (fs.existsSync(SESSION_FILE)) {
    try {
      const data = fs.readFileSync(SESSION_FILE, 'utf8');
      const savedSessions = JSON.parse(data);
      Object.assign(royalHeroesSessions, savedSessions);
      for (const [key, session] of Object.entries(royalHeroesSessions)) {
        if (session.phoneNumber && session.uniqueKey) {
          console.log(chalk.cyan(`🔄 Restoring session: ${session.phoneNumber}`));
          await royalConnectAndLogin(session.phoneNumber, session.uniqueKey, null);
        }
      }
    } catch (err) {
      console.error(chalk.red(`Error restoring sessions: ${err.message}`));
    }
  }
};

app.post('/login', async (req, res) => {
  try {
    let { phoneNumber } = req.body;
    if (!phoneNumber) return res.status(400).json({ success: false, message: 'Phone number is required!' });
    phoneNumber = phoneNumber.replace(/[^0-9]/g, '');
    const uniqueKey = royalGenerateUniqueKey();
    const sendPairingCode = (pairingCode, isConnected = false, errorMsg = null) => {
      if (errorMsg) res.json({ success: false, message: 'Error generating pairing code', error: errorMsg, uniqueKey });
      else if (isConnected) res.json({ success: true, message: 'WhatsApp Connected!', connected: true, uniqueKey });
      else res.json({ success: true, message: 'Pairing code generated', pairingCode, uniqueKey });
    };
    await royalConnectAndLogin(phoneNumber, uniqueKey, sendPairingCode);
  } catch (error) {
    res.status(500).json({ success: false, message: `Server Error: ${error.message}` });
  }
});

app.post('/getGroupUID', async (req, res) => {
  try {
    const { uniqueKey } = req.body;
    if (!uniqueKey || !royalActiveSockets[uniqueKey]) return res.status(400).json({ success: false, message: 'Invalid session or not connected' });
    const groups = await royalActiveSockets[uniqueKey].groupFetchAllParticipating();
    const groupUIDs = Object.values(groups).map(group => ({ groupName: group.subject, groupId: group.id }));
    res.json({ success: true, groupUIDs });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/startMessaging', upload.single('messageFile'), async (req, res) => {
  try {
    const { uniqueKey, target, hatersName, speed } = req.body;
    const filePath = req.file?.path;
    if (!uniqueKey || !target || !royalActiveSockets[uniqueKey] || !filePath) return res.status(400).json({ success: false, message: 'Missing fields' });
    const fileContent = fs.readFileSync(filePath, 'utf-8');
    const messages = fileContent.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    fs.unlinkSync(filePath);
    royalHeroesSessions[uniqueKey] = { ...royalHeroesSessions[uniqueKey], target, hatersName, messages, speed, messaging: true };
    royalSaveSessions();
    royalStartMessaging(royalActiveSockets[uniqueKey], uniqueKey, target, hatersName, messages, speed);
    res.json({ success: true, message: 'Messaging started' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/stop', async (req, res) => {
  const { uniqueKey } = req.body;
  if (!uniqueKey || !royalHeroesSessions[uniqueKey]) return res.status(400).json({ success: false, message: 'Invalid session' });
  royalConnectionStates[uniqueKey] = RoyalSessionState.STOPPED;
  if (royalStopFlags[uniqueKey]?.timeout) clearTimeout(royalStopFlags[uniqueKey].timeout);
  if (royalActiveSockets[uniqueKey]) {
    try {
      await royalActiveSockets[uniqueKey].logout();
      delete royalActiveSockets[uniqueKey];
    } catch (e) { delete royalActiveSockets[uniqueKey]; }
  }
  const sessionPath = `./session/${uniqueKey}`;
  if (fs.existsSync(sessionPath)) fs.rmdirSync(sessionPath, { recursive: true });
  delete royalHeroesSessions[uniqueKey];
  royalSaveSessions();
  res.json({ success: true, message: 'Stopped 
