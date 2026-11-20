using System.Collections.Concurrent;
using DbStudio.Core;

namespace DbStudio.Host.Services;

/// <summary>Metadata per connection, kept until the user presses Refresh or edits the connection.</summary>
internal sealed class MetadataCache
{
    private readonly ConcurrentDictionary<Guid, SchemaMetadata> _dicCache = new();

    public bool TryGet(Guid guidId, out SchemaMetadata objMeta) => _dicCache.TryGetValue(guidId, out objMeta!);
    public void Set(Guid guidId, SchemaMetadata objMeta) => _dicCache[guidId] = objMeta;
    public void Invalidate(Guid guidId) => _dicCache.TryRemove(guidId, out _);

    /// <summary>Applies fnChange to the cached value (objFallback if it was dropped meanwhile). Two schemas
    /// loading at once must not overwrite each other.</summary>
    public SchemaMetadata Update(Guid guidId, SchemaMetadata objFallback, Func<SchemaMetadata, SchemaMetadata> fnChange) =>
        _dicCache.AddOrUpdate(guidId, _ => fnChange(objFallback), (_, objCurrent) => fnChange(objCurrent));
}
