const { startGuardianSession } = require('./src/lib/guardian-runtime');

try {
    const result = startGuardianSession({
        topic: 'Learn zk snarks',
        durationMinutes: 60,
        source: 'dashboard'
    });
    console.log('Success:', result.sessionId);
} catch (err) {
    console.error('FAILED:', err);
}
