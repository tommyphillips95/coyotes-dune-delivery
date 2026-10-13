const { initDb } = require('../database');

// Initialize the database
try {
  initDb();
  console.log('Database initialized successfully');
  process.exit(0);
} catch (error) {
  console.error('Error initializing database:', error);
  process.exit(1);
}
