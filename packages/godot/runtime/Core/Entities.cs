using System.Collections.Generic;
using Godot;

namespace Aige;

/// <summary>
/// Finds AIGE entities in the running scene. An entity reference is an entity id (<c>aige_id</c>
/// metadata, e.g. 'e12'), a node path from the scene root ('Level/Kitchen/Fridge') or a node name
/// ('Fridge'), tried in that order.
/// </summary>
public static class Entities
{
    /// <summary>The current scene root (null during scene changes).</summary>
    public static Node? SceneRoot => (Engine.GetMainLoop() as SceneTree)?.CurrentScene;

    /// <summary>Finds an entity node by id, path or name.</summary>
    /// <example><code>var fridge = Entities.Find("Kitchen/Fridge");</code></example>
    public static Node3D? Find(string? reference, Node? root = null) => FindNode(reference, root) as Node3D;

    /// <summary>Finds an entity and returns it as <typeparamref name="T"/> (null if missing or of another type).</summary>
    public static T? Find<T>(string? reference, Node? root = null) where T : class => FindNode(reference, root) as T;

    /// <summary>Finds any node (not only Node3D) by id, path or name.</summary>
    public static Node? FindNode(string? reference, Node? root = null)
    {
        if (string.IsNullOrWhiteSpace(reference)) return null;
        root ??= SceneRoot;
        if (root == null) return null;
        var byId = FindById(root, reference);
        if (byId != null) return byId;
        if (!reference.StartsWith('/'))
        {
            var byPath = root.GetNodeOrNull(reference);
            if (byPath != null) return byPath;
        }
        var name = reference.TrimStart('%');
        var slash = name.LastIndexOf('/');
        if (slash >= 0) name = name[(slash + 1)..];
        return FindByName(root, name);
    }

    static Node? FindById(Node root, string id)
    {
        var queue = new Queue<Node>();
        queue.Enqueue(root);
        while (queue.Count > 0)
        {
            var n = queue.Dequeue();
            if (n.HasMeta("aige_id") && n.GetMeta("aige_id").AsString() == id) return n;
            foreach (var c in n.GetChildren()) queue.Enqueue(c);
        }
        return null;
    }

    static Node? FindByName(Node root, string name)
    {
        var queue = new Queue<Node>();
        foreach (var c in root.GetChildren()) queue.Enqueue(c);
        while (queue.Count > 0)
        {
            var n = queue.Dequeue();
            if (n.Name == name) return n;
            foreach (var c in n.GetChildren()) queue.Enqueue(c);
        }
        return null;
    }

    /// <summary>All entities in a group (entity tags become groups, e.g. 'Player').</summary>
    public static IEnumerable<Node3D> Tagged(string tag)
    {
        if (Engine.GetMainLoop() is not SceneTree tree) yield break;
        foreach (var n in tree.GetNodesInGroup(tag))
            if (n is Node3D n3) yield return n3;
    }

    /// <summary>The player: the first node in group 'Player', else the PlayerController.</summary>
    public static Node3D? Player
    {
        get
        {
            foreach (var n in Tagged("Player")) return n;
            return PlayerController.Instance;
        }
    }

    /// <summary>
    /// A component of an entity: the entity itself if it is a <typeparamref name="T"/>, else its first
    /// direct child of that type (component nodes are children named after the component).
    /// </summary>
    public static T? Component<T>(Node? entity) where T : class
    {
        if (entity == null) return null;
        if (entity is T self) return self;
        foreach (var c in entity.GetChildren())
            if (c is T t) return t;
        return null;
    }

    /// <summary>First descendant of type <typeparamref name="T"/> (breadth-first).</summary>
    public static T? Descendant<T>(Node? root, int maxDepth = 12) where T : class
    {
        if (root == null) return null;
        var queue = new Queue<(Node node, int depth)>();
        queue.Enqueue((root, 0));
        while (queue.Count > 0)
        {
            var (n, d) = queue.Dequeue();
            if (n is T t) return t;
            if (d >= maxDepth) continue;
            foreach (var c in n.GetChildren()) queue.Enqueue((c, d + 1));
        }
        return null;
    }

    /// <summary>Shows or hides an entity and turns its processing and collisions on or off.</summary>
    public static void SetEnabled(Node? entity, bool enabled)
    {
        if (entity == null) return;
        if (entity is Node3D n3) n3.Visible = enabled;
        entity.ProcessMode = enabled ? Node.ProcessModeEnum.Inherit : Node.ProcessModeEnum.Disabled;
        foreach (var c in entity.GetChildren())
            if (c is Interactable i) i.Enabled = enabled;
    }

    /// <summary>
    /// A good point to look at or aim for on an entity: the center of its visible meshes, or head
    /// height for characters. Falls back to the origin.
    /// </summary>
    public static Vector3 FocusPoint(Node3D node)
    {
        if (node is CharacterBody3D || node.IsInGroup("Player"))
            return node.GlobalPosition + Vector3.Up * 1.55f;
        var box = WorldBounds(node);
        return box?.GetCenter() ?? node.GlobalPosition;
    }

    /// <summary>World-space bounds of all visible meshes under <paramref name="node"/> (null if none).</summary>
    public static Aabb? WorldBounds(Node3D node)
    {
        Aabb? result = null;
        var stack = new Stack<Node>();
        stack.Push(node);
        while (stack.Count > 0)
        {
            var n = stack.Pop();
            if (n is VisualInstance3D vi and (MeshInstance3D or CsgShape3D) && vi.IsVisibleInTree())
            {
                var box = vi.GlobalTransform * vi.GetAabb();
                result = result == null ? box : result.Value.Merge(box);
            }
            foreach (var c in n.GetChildren()) stack.Push(c);
        }
        return result;
    }

    /// <summary>
    /// Moves an entity to a world position, optionally with a rotation (Euler degrees, XYZ like AIGE).
    /// Characters stop moving; the player's camera follows.
    /// </summary>
    public static void Teleport(Node3D node, Vector3 position, Vector3? rotationDeg = null)
    {
        node.GlobalPosition = position;
        if (rotationDeg is { } r)
        {
            var rad = new Vector3(Mathf.DegToRad(r.X), Mathf.DegToRad(r.Y), Mathf.DegToRad(r.Z));
            node.GlobalBasis = Basis.FromEuler(rad, EulerOrder.Xyz).Scaled(node.GlobalBasis.Scale);
        }
        if (node is CharacterBody3D body) body.Velocity = Vector3.Zero;
        if (node is PlayerController pc) pc.OnTeleported();
    }

    /// <summary>Display name of an entity for logs and reports.</summary>
    public static string NameOf(Node? n) => n == null ? "" : n.Name.ToString();

    /// <summary>True when <paramref name="node"/> is <paramref name="ancestor"/> or inside it.</summary>
    public static bool IsInside(Node? node, Node? ancestor)
    {
        if (node == null || ancestor == null) return false;
        return node == ancestor || ancestor.IsAncestorOf(node);
    }
}
