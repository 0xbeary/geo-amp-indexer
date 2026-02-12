-- Count EditsPublished events by Space plugin contract
-- Shows which spaces are most active

SELECT 
    evm_decode_hex(address) as space_plugin_address,
    COUNT(*) as event_count
FROM "_/geo_testnet".logs
WHERE topic0 = evm_topic('EditsPublished(address indexed dao, string editsContentUri, bytes editsMetadata)')
GROUP BY address
ORDER BY event_count DESC;
