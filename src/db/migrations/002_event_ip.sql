-- 事件改為同時保存實際 IP；ip_hash 保留，讓新舊紀錄仍可用雜湊互相比對
ALTER TABLE events ADD COLUMN ip TEXT;
