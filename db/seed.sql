INSERT INTO oxide_bot_agents (id, name, device_name, status)
VALUES
  ('bot-01', 'Oxide Bot 01', 'oxide-worker-01', 'online'),
  ('bot-02', 'Oxide Bot 02', 'oxide-worker-02', 'online'),
  ('bot-03', 'Oxide Bot 03', 'oxide-worker-03', 'offline')
ON CONFLICT (id) DO NOTHING;

INSERT INTO orders (external_order_id, status, amount, currency)
VALUES
  ('TEST-ORDER-001', 'processing', 1250.00, 'THB'),
  ('TEST-ORDER-002', 'pending', 499.00, 'THB')
ON CONFLICT (external_order_id) DO NOTHING;
