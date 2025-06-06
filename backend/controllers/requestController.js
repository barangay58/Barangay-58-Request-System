const pool = require("../config/db");
const { validationResult } = require('express-validator');

// Helper functions
const getOrCreateSuffixId = async (suffix) => {
  if (!suffix) return null;

  const [rows] = await pool.query(
    "SELECT id FROM suffixes WHERE LOWER(name) = LOWER(?) LIMIT 1",
    [suffix.trim()]
  );

  if (rows.length > 0) {
    return rows[0].id;
  }

  const [result] = await pool.query(
    "INSERT INTO suffixes (name) VALUES (?)",
    [suffix.trim()]
  );

  return result.insertId;
};

const validateSexId = async (sexId) => {
  if (!sexId) return false;
  const [rows] = await pool.query(
    "SELECT id FROM sex_options WHERE id = ?",
    [sexId]
  );
  return rows.length > 0;
};

const backupRequest = async (connection, requestData) => {
  // Remove any existing backup for this original_id
  await connection.execute(
    "DELETE FROM backup_requests WHERE original_id = ?",
    [requestData.id]
  );
  await connection.execute(
    `INSERT INTO backup_requests 
     (last_name, first_name, middle_name, suffix_id, sex, sex_other, birthday, 
      contact_no, email, address, certificate_id, 
      purpose_of_request, number_of_copies, status_id, original_id, created_at, photo_url, s3_key, control_id) 
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      requestData.last_name,
      requestData.first_name,
      requestData.middle_name,
      requestData.suffix_id,
      requestData.sex,
      requestData.sex_other,
      requestData.birthday,
      requestData.contact_no,
      requestData.email,
      requestData.address,
      requestData.certificate_id,
      requestData.purpose_of_request,
      requestData.number_of_copies,
      requestData.status_id || 1, // Default to pending (1)
      requestData.id,
      requestData.created_at,
      requestData.photo_url || null,
      requestData.s3_key || null,
      requestData.control_id || null // <-- Copy control_id to backup
    ]
  );
};

exports.createRequest = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();

    const {
      last_name,
      first_name,
      middle_name,
      suffix_id,
      sex,
      sex_other,
      birthday,
      contact_no,
      email,
      address,
      certificate_id,
      purpose_of_request,
      number_of_copies,
      s3_key,  // Make sure these are destructured
      photo_url // from req.body
    } = req.body;

    // Validate sex option
    if (sex && !(await validateSexId(sex))) {
      await connection.rollback();
      return res.status(400).json({ error: 'Invalid sex option' });
    }

    // Validate certificate exists
    const [certRows] = await connection.query(
      "SELECT id FROM certificates WHERE id = ?",
      [certificate_id]
    );
    if (certRows.length === 0) {
      await connection.rollback();
      return res.status(400).json({ error: 'Invalid certificate type' });
    }

    // Insert main request (default status_id = 1 for pending)
    const [result] = await connection.execute(
      `INSERT INTO requests
       (last_name, first_name, middle_name, suffix_id, sex, sex_other, birthday,
        contact_no, email, address, certificate_id,
        purpose_of_request, number_of_copies, status_id, photo_url, s3_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        last_name,
        first_name,
        middle_name,
        suffix_id || null,
        sex,
        sex_other || null,
        birthday,
        contact_no,
        email,
        address,
        certificate_id,
        purpose_of_request,
        number_of_copies,
        1, // Default status_id (pending)
        photo_url || null,
        s3_key || null
      ]
    );

    // Get complete request data with joins
    const [request] = await connection.query(
      `SELECT r.*, 
        so.name as sex_name,
        s.name as suffix,
        c.name as certificate_name,
        rs.name as status,
        CASE WHEN so.requires_input = 1 THEN r.sex_other ELSE so.name END as sex_display
       FROM requests r
       LEFT JOIN sex_options so ON r.sex = so.id
       LEFT JOIN suffixes s ON r.suffix_id = s.id
       LEFT JOIN certificates c ON r.certificate_id = c.id
       LEFT JOIN request_statuses rs ON r.status_id = rs.id
       WHERE r.id = ?`,
      [result.insertId]
    );

    await connection.commit();
    res.status(201).json({ success: true, request: request[0] });
  } catch (error) {
    await connection.rollback();
    console.error('Error creating request:', error);
    res.status(500).json({
      error: 'Request processing failed',
      details: error.message
    });
  } finally {
    connection.release();
  }
};

exports.getRequests = async (req, res) => {
  try {
    const { status_id } = req.query;
    let query = `
      SELECT r.id, r.last_name, r.first_name, r.middle_name, r.suffix_id,
             r.sex, r.sex_other, DATE_FORMAT(r.birthday, '%Y-%m-%d') as birthday,
             r.contact_no, r.email, r.address, r.certificate_id,
             r.control_id,
             c.name as certificate_name,
             r.purpose_of_request, r.number_of_copies, 
             r.status_id, rs.name as status,
             r.photo_url, r.s3_key,
             DATE_FORMAT(CONVERT_TZ(r.created_at, 'UTC', 'Asia/Manila'), '%Y-%m-%d %H:%i:%s') as created_at,
             so.name as sex_name,
             s.name as suffix,
             CASE WHEN so.requires_input = 1 THEN r.sex_other ELSE so.name END as sex_display
      FROM requests r
      LEFT JOIN sex_options so ON r.sex = so.id
      LEFT JOIN certificates c ON r.certificate_id = c.id
      LEFT JOIN suffixes s ON r.suffix_id = s.id
      LEFT JOIN request_statuses rs ON r.status_id = rs.id
    `;

    const params = [];
    if (status_id) {
      query += ` WHERE r.status_id = ?`;
      params.push(status_id);
    }

    query += ` ORDER BY r.created_at DESC`;

    try {
      const [rows] = await pool.query(query, params);
      res.status(200).json(rows);
    } catch (sqlError) {
      // Log the full SQL error and try a minimal query for debugging
      console.error("SQL error in getRequests:", sqlError.stack || sqlError);

      // Try a minimal query to see if the requests table itself is OK
      try {
        const [rows] = await pool.query("SELECT * FROM requests LIMIT 5");
        res.status(500).json({
          message: "Failed to fetch requests (see server logs for details)",
          sqlError: sqlError.message,
          requestsTableSample: rows
        });
      } catch (minimalError) {
        console.error("Minimal query also failed:", minimalError.stack || minimalError);
        res.status(500).json({
          message: "Failed to fetch requests (minimal query also failed)",
          sqlError: sqlError.message,
          minimalError: minimalError.message
        });
      }
    }
  } catch (error) {
    // Enhanced error logging
    console.error("Database error in getRequests (outer catch):", error.stack || error);
    res.status(500).json({ message: "Failed to fetch requests", error: error.message });
  }
};

exports.getRequestById = async (req, res) => {
  const { id } = req.params;
  try {
    const [rows] = await pool.query(
      `SELECT r.*, 
        so.name as sex_name,
        rs.name as status,
        CASE WHEN so.requires_input = 1 THEN r.sex_other ELSE so.name END as sex_display
       FROM requests r
       LEFT JOIN sex_options so ON r.sex = so.id
       LEFT JOIN request_statuses rs ON r.status_id = rs.id
       WHERE r.id = ?`,
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Request not found' });
    }

    res.json(rows[0]);
  } catch (error) {
    console.error('Database error:', error);
    res.status(500).json({
      error: 'Database operation failed',
      details: error.message
    });
  }
};

exports.updateRequestStatus = async (req, res) => {
  const { id } = req.params;
  const { status_id } = req.body;

  if (!status_id || isNaN(status_id)) {
    return res.status(400).json({ error: 'Invalid status_id' });
  }

  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();

    // Get the current request with certificate name
    const [requestRows] = await connection.query(`
      SELECT r.*, c.name as certificate_name 
      FROM requests r 
      JOIN certificates c ON r.certificate_id = c.id 
      WHERE r.id = ?`, 
      [id]
    );
    
    if (requestRows.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: 'Request not found' });
    }

    const request = requestRows[0];

    // Validate status_id exists
    const [statusRows] = await connection.query(
      "SELECT name FROM request_statuses WHERE id = ?",
      [status_id]
    );
    
    if (statusRows.length === 0) {
      await connection.rollback();
      return res.status(400).json({ error: 'Invalid status_id' });
    }

    // Do not generate or set control_id, just update status_id
    await connection.query(
      "UPDATE requests SET status_id = ? WHERE id = ?",
      [status_id, id]
    );

    // Get updated request data to return
    const [updatedRequest] = await connection.query(
      `SELECT r.*, rs.name as status 
       FROM requests r
       LEFT JOIN request_statuses rs ON r.status_id = rs.id
       WHERE r.id = ?`,
      [id]
    );

    await connection.commit();

    res.json({ 
      success: true, 
      message: 'Status updated successfully',
      request: updatedRequest[0]
    });
  } catch (error) {
    await connection.rollback();
    console.error('Database error:', error);
    res.status(500).json({
      error: 'Database operation failed',
      details: error.message
    });
  } finally {
    connection.release();
  }
};

exports.deleteRequest = async (req, res) => {
  const { id } = req.params;
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const [request] = await connection.execute(
      "SELECT * FROM requests WHERE id = ?",
      [id]
    );

    if (request.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: 'Request not found' });
    }

    await backupRequest(connection, request[0]);

    const [result] = await connection.execute(
      "DELETE FROM requests WHERE id = ?",
      [id]
    );

    if (result.affectedRows === 0) {
      await connection.rollback();
      return res.status(404).json({ error: 'Request not found' });
    }

    await connection.commit();
    res.json({ success: true, message: 'Request deleted and archived successfully' });
  } catch (error) {
    await connection.rollback();
    console.error('Database error:', error);
    res.status(500).json({
      error: 'Database operation failed',
      details: error.message
    });
  } finally {
    connection.release();
  }
};

exports.getBackupRequests = async (req, res) => {
  try {
    console.log('User accessing backups:', req.user.username);
    
    const [rows] = await pool.query(`
      SELECT b.id, b.last_name, b.first_name, b.middle_name, 
             s.name as suffix, b.suffix_id,
             b.sex, b.sex_other, DATE_FORMAT(b.birthday, '%Y-%m-%d') as birthday,
             b.contact_no, b.email, b.address, b.certificate_id,
             c.name as certificate_name,
             b.purpose_of_request, b.number_of_copies, 
             b.status_id, rs.name as status,
             b.original_id,
             DATE_FORMAT(CONVERT_TZ(b.created_at, 'UTC', 'Asia/Manila'), '%Y-%m-%d %H:%i:%s') as created_at,
             b.photo_url, b.s3_key,
             so.name as sex_name,
             CASE WHEN so.requires_input = 1 THEN b.sex_other ELSE so.name END as sex_display
      FROM backup_requests b
      LEFT JOIN sex_options so ON b.sex = so.id
      LEFT JOIN suffixes s ON b.suffix_id = s.id
      LEFT JOIN certificates c ON b.certificate_id = c.id
      LEFT JOIN request_statuses rs ON b.status_id = rs.id
      ORDER BY b.created_at DESC
    `);
    
    res.status(200).json(rows);
  } catch (error) {
    console.error("Database error:", error);
    res.status(500).json({ 
      message: "Failed to fetch backup requests",
      error: error.message 
    });
  }
};

exports.restoreRequests = async (req, res) => {
  const { requestIds, status_id } = req.body;
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    for (const id of requestIds) {
      const [backupRequestRows] = await connection.execute(
        "SELECT * FROM backup_requests WHERE id = ?",
        [id]
      );

      if (backupRequestRows.length === 0) {
        await connection.rollback();
        return res.status(404).json({ error: `Backup request with id ${id} not found` });
      }

      const requestData = backupRequestRows[0];
      // If status_id is provided in the restore call, use it; otherwise use the backup's status_id
      const restoreStatusId = status_id || requestData.status_id;

      await connection.execute(
        `INSERT INTO requests 
         (last_name, first_name, middle_name, suffix_id, sex, sex_other, birthday,
          contact_no, email, address, certificate_id,
          purpose_of_request, number_of_copies, status_id, created_at, photo_url, s3_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          requestData.last_name,
          requestData.first_name,
          requestData.middle_name,
          requestData.suffix_id,
          requestData.sex,
          requestData.sex_other,
          requestData.birthday,
          requestData.contact_no,
          requestData.email,
          requestData.address,
          requestData.certificate_id,
          requestData.purpose_of_request,
          requestData.number_of_copies,
          restoreStatusId,
          requestData.created_at,
          requestData.photo_url,
          requestData.s3_key
        ]
      );

      await connection.execute(
        "DELETE FROM backup_requests WHERE id = ?",
        [id]
      );
    }

    await connection.commit();
    res.json({ success: true, message: `Successfully restored ${requestIds.length} request(s)` });
  } catch (error) {
    await connection.rollback();
    console.error('Database error:', error);
    res.status(500).json({
      error: 'Database operation failed',
      details: error.message
    });
  } finally {
    connection.release();
  }
};

// Generate control_id for eligible requests
exports.generateControlId = async (req, res) => {
  const { id } = req.params;
  const eligibleCertificateNames = [
    'Barangay ID Application',
    'Barangay Clearance',
    'Certificate of Indigency',
    'Barangay ID',
    'Barangay Certificate',
    'Clearance',
    'Indigency'
  ];

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // Get request and certificate info
    const [rows] = await connection.query(
      `SELECT r.*, c.name as certificate_name FROM requests r
       JOIN certificates c ON r.certificate_id = c.id
       WHERE r.id = ?`,
      [id]
    );
    
    if (rows.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: 'Request not found' });
    }
    
    const request = rows[0];

    // If already has control_id, return it (do not change)
    if (request.control_id) {
      await connection.commit();
      return res.json({ control_id: request.control_id });
    }

    // Only generate for eligible certificate types
    if (!eligibleCertificateNames.map(n => n.toLowerCase()).includes(request.certificate_name.toLowerCase())) {
      await connection.commit();
      return res.json({ control_id: null });
    }

    // Get the highest existing control_id for this certificate type in the current year from both requests and backup_requests
    const currentYear = new Date().getFullYear();
    const controlIdLike = `${currentYear}-%`;

    // Get max from requests
    const [maxIdRowsRequests] = await connection.query(
      `SELECT MAX(CAST(SUBSTRING_INDEX(control_id, '-', -1) AS UNSIGNED)) as max_id
       FROM requests
       WHERE certificate_id = ? AND control_id LIKE ? AND control_id IS NOT NULL`,
      [request.certificate_id, controlIdLike]
    );

    // Get max from backup_requests
    const [maxIdRowsBackup] = await connection.query(
      `SELECT MAX(CAST(SUBSTRING_INDEX(control_id, '-', -1) AS UNSIGNED)) as max_id
       FROM backup_requests
       WHERE certificate_id = ? AND control_id LIKE ? AND control_id IS NOT NULL`,
      [request.certificate_id, controlIdLike]
    );

    const maxIdRequests = maxIdRowsRequests[0].max_id || 0;
    const maxIdBackup = maxIdRowsBackup[0].max_id || 0;
    const nextId = Math.max(maxIdRequests, maxIdBackup) + 1;
    const paddedId = nextId.toString().padStart(4, '0');
    const controlId = `${currentYear}-${paddedId}`;

    // Update the request with the new control_id
    await connection.query(
      `UPDATE requests SET control_id = ? WHERE id = ?`,
      [controlId, id]
    );

    await connection.commit();
    res.json({ control_id: controlId });
  } catch (error) {
    await connection.rollback();
    console.error('Error generating control_id:', error);
    res.status(500).json({ error: 'Failed to generate control_id', details: error.message });
  } finally {
    connection.release();
  }
};

// Get all available statuses
exports.getStatuses = async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM request_statuses ORDER BY id");
    res.status(200).json(rows);
  } catch (error) {
    console.error("Database error:", error);
    res.status(500).json({ message: "Failed to fetch statuses", error: error.message });
  }
};