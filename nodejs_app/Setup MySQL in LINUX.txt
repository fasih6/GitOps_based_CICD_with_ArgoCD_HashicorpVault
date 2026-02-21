              Setup MySQL in LINUX

sudo apt install mysql-server -y

sudo mysql -u root -p

ALTER USER 'root'@'localhost' IDENTIFIED WITH mysql_native_password BY 'Aditya';
FLUSH PRIVILEGES;
EXIT;

-- Create the database if not already exists
CREATE DATABASE IF NOT EXISTS crud_app;

-- Switch to the database
USE crud_app;

-- Drop table if needed (optional safety cleanup)
-- DROP TABLE IF EXISTS users;

-- Create the `users` table with proper structure
CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) NOT NULL UNIQUE,
  password VARCHAR(255) NOT NULL,
  role ENUM('admin', 'viewer') NOT NULL DEFAULT 'viewer',
  is_active TINYINT(1) DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
