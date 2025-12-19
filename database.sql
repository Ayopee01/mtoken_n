CREATE TABLE IF NOT EXISTS personal_data (
    user_id VARCHAR(255) PRIMARY KEY,
    citizen_id VARCHAR(255) UNIQUE,
    first_name VARCHAR(255),
    last_name VARCHAR(255),
    date_of_birth VARCHAR(255),
    mobile VARCHAR(255),
    email VARCHAR(255),
    notification VARCHAR(50),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);