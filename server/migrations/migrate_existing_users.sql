INSERT INTO broadcast_users (chat_id, username, first_name, last_name, created_at, updated_at, is_active)
SELECT 
    user_chat_id::bigint as chat_id,
    NULL as username,
    NULL as first_name,
    NULL as last_name, 
    NOW() as created_at,
    NOW() as updated_at,
    TRUE as is_active
FROM orders 
WHERE user_chat_id IS NOT NULL 
  AND user_chat_id::text ~ '^[0-9]+$'
ON CONFLICT (chat_id) DO NOTHING;

DO $$
DECLARE
    user_count integer;
BEGIN
    SELECT COUNT(*) INTO user_count FROM broadcast_users;
    RAISE NOTICE 'Миграция завершена. Всего пользователей в broadcast_users: %', user_count;
END $$;
