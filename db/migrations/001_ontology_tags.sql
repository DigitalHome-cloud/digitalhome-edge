-- Migration 001: Add DHC ontology columns to device table
-- Aligns device inventory with dhc-core.schema.ttl T-Box classes

ALTER TABLE device ADD COLUMN dhc_class TEXT;
ALTER TABLE device ADD COLUMN design_view TEXT;
ALTER TABLE device ADD COLUMN capability TEXT;
ALTER TABLE device ADD COLUMN model TEXT;
ALTER TABLE device ADD COLUMN manufacturer TEXT;
ALTER TABLE device ADD COLUMN ccu_ise_id TEXT;
ALTER TABLE device ADD COLUMN hue_unique_id TEXT;
