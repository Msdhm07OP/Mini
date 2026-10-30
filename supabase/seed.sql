-- Seed the official EventSync hackathon dataset on a fresh Supabase project.
INSERT INTO public.venues (name) VALUES ('Venue A'), ('Venue B'), ('Venue C')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.resource_types (name, description, unit) VALUES
  ('projector', 'Digital projectors for presentations', 'units'),
  ('audio_system', 'Audio systems for events', 'units'),
  ('support_staff', 'Support staff members', 'people')
ON CONFLICT (name) DO NOTHING;

INSERT INTO public.halls (venue_id, name, capacity)
SELECT v.id, x.hall_name, x.capacity
FROM (VALUES ('Venue A','A1',60),('Venue A','A2',150),('Venue B','B1',100),('Venue B','B2',200),('Venue C','C1',80),('Venue C','C2',250)) AS x(venue_name,hall_name,capacity)
JOIN public.venues v ON v.name=x.venue_name
ON CONFLICT (venue_id,name) DO UPDATE SET capacity=EXCLUDED.capacity, is_active=true;

INSERT INTO public.venue_resource_capacity (venue_id, resource_type_id, capacity)
SELECT v.id, rt.id, x.capacity
FROM (VALUES
  ('Venue A','projector',2),('Venue A','audio_system',2),('Venue A','support_staff',5),
  ('Venue B','projector',2),('Venue B','audio_system',1),('Venue B','support_staff',4),
  ('Venue C','projector',3),('Venue C','audio_system',2),('Venue C','support_staff',6)
) AS x(venue_name,resource_name,capacity)
JOIN public.venues v ON v.name=x.venue_name
JOIN public.resource_types rt ON rt.name=x.resource_name
ON CONFLICT (venue_id,resource_type_id) DO UPDATE SET capacity=EXCLUDED.capacity;

-- Demo client records. Safe to rerun; existing clients/bookings are preserved.
INSERT INTO public.clients (name, email, phone, organization)
SELECT x.name, x.email, x.phone, x.organization
FROM (VALUES
  ('TechCorp Solutions', 'contact@techcorp.com', '+1-555-0101', 'Technology Company'),
  ('Marketing Masters', 'events@marketingmasters.com', '+1-555-0102', 'Marketing Agency'),
  ('Innovation Labs', 'hello@innovationlabs.io', '+1-555-0103', 'Research Institute'),
  ('Global Ventures', 'info@globalventures.com', '+1-555-0104', 'Investment Firm'),
  ('Creative Studio', 'bookings@creativestudio.net', '+1-555-0105', 'Design Agency')
) AS x(name, email, phone, organization)
WHERE NOT EXISTS (
  SELECT 1 FROM public.clients c WHERE lower(c.email) = lower(x.email)
);
