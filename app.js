const express = require('express');
const path = require('path');
const cors = require('cors');

// Requiring './db' here (before the routers) means a bad/missing
// FIREBASE_SERVICE_ACCOUNT fails loudly and immediately on startup,
// instead of surfacing as a confusing error on the first real request.
require('./db');

const { router: adminRouter } = require('./routes/admin');
const ivrRouter = require('./routes/ivr');
const displayRouter = require('./routes/display');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // Yemot can POST as form-encoded

// Static pages: admin dashboard + live display screen
app.use(express.static(path.join(__dirname, 'public')));

app.use('/admin', adminRouter);
app.use('/ivr', ivrRouter);
app.use('/display', displayRouter);

app.get('/', (req, res) => res.send('Survey API is running'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Survey API listening on port ${PORT}`));

module.exports = app;
