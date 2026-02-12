-- EditsPublished events timeline
-- Daily count of edits across all spaces

SELECT 
    DATE_TRUNC('day', timestamp) as day,
    COUNT(*) as edits_count,
    COUNT(DISTINCT address) as unique_spaces
FROM "_/geo_testnet".logs
WHERE topic0 = evm_topic('EditsPublished(address indexed dao, string editsContentUri, bytes editsMetadata)')
GROUP BY DATE_TRUNC('day', timestamp)
ORDER BY day DESC;
