const { pool } = require('../db/db');

/**
 * Adds a stream for a specific school, class, and academic year. Streams
 * are never shared across schools or reused across years - each is its
 * own row, tied to a specific cohort's time in a specific class.
 */
async function addStream(schoolId, classId, academicYearId, name) {
  const result = await pool.query(
    `INSERT INTO streams (school_id, class_id, academic_year_id, name) VALUES ($1, $2, $3, $4) RETURNING *`,
    [schoolId, classId, academicYearId, name]
  );
  return result.rows[0];
}

async function renameStream(streamId, newName) {
  const result = await pool.query(
    `UPDATE streams SET name = $1 WHERE id = $2 RETURNING *`,
    [newName, streamId]
  );
  return result.rows[0];
}

/**
 * Removes a stream - only if no active student is currently in it.
 */
async function removeStream(streamId) {
  const activeStudents = await pool.query(
    `SELECT COUNT(*) as count FROM students WHERE stream_id = $1 AND status = 'active'`,
    [streamId]
  );
  const count = Number(activeStudents.rows[0].count);
  if (count > 0) {
    throw new Error(
      `Cannot remove this stream - ${count} active student(s) are still in it. ` +
      `Transfer them to another stream first.`
    );
  }
  await pool.query(`DELETE FROM streams WHERE id = $1`, [streamId]);
  return { removed: true };
}

async function transferStudentToStream(schoolId, studentId, newStreamId) {
  // The student must belong to the caller's school...
  const student = await pool.query(
    `SELECT id, class_id FROM students WHERE id = $1 AND school_id = $2`,
    [studentId, schoolId]
  );
  if (student.rows.length === 0) throw new Error(`No student found with id ${studentId}`);

  // ...and so must the target stream, otherwise a student could be moved
  // into another school's stream.
  if (newStreamId != null) {
    const stream = await pool.query(
      `SELECT id FROM streams WHERE id = $1 AND school_id = $2`,
      [newStreamId, schoolId]
    );
    if (stream.rows.length === 0) throw new Error(`No stream found with id ${newStreamId} in this school`);
  }

  const result = await pool.query(
    `UPDATE students SET stream_id = $1 WHERE id = $2 AND school_id = $3 RETURNING id, class_id, stream_id`,
    [newStreamId, studentId, schoolId]
  );
  return result.rows[0];
}

/**
 * Lists a school's streams for a specific class, in a specific academic
 * year - this is what a "current streams" screen would show, since a
 * stream from a past year is history, not something to manage today.
 */
async function listStreamsForClass(schoolId, classId, academicYearId) {
  const result = await pool.query(
    `SELECT s.*, COUNT(st.id) FILTER (WHERE st.status = 'active') as student_count
     FROM streams s
     LEFT JOIN students st ON st.stream_id = s.id
     WHERE s.school_id = $1 AND s.class_id = $2 AND s.academic_year_id = $3
     GROUP BY s.id`,
    [schoolId, classId, academicYearId]
  );
  return result.rows;
}

module.exports = { addStream, renameStream, removeStream, transferStudentToStream, listStreamsForClass };
