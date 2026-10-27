const { pool } = require('../db/db');

async function listClassesForSchool(schoolId) {
  const result = await pool.query(
    `SELECT c.id, c.name, c.sort_order, COALESCE(sc.enabled, FALSE) as enabled
     FROM classes c
     LEFT JOIN school_classes sc ON sc.class_id = c.id AND sc.school_id = $1
     ORDER BY c.sort_order`,
    [schoolId]
  );
  return result.rows;
}

async function setClassEnabled(schoolId, classId, enabled) {
  const result = await pool.query(
    `INSERT INTO school_classes (school_id, class_id, enabled) VALUES ($1, $2, $3)
     ON CONFLICT (school_id, class_id) DO UPDATE SET enabled = $3
     RETURNING *`,
    [schoolId, classId, enabled]
  );
  return result.rows[0];
}

module.exports = { listClassesForSchool, setClassEnabled };
