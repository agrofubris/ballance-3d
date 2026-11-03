// WebAssembly bridge between the game and the IVP physics SDK.
// Exposes a flat C interface over one IVP environment per module instance.
// Units, axes and handedness are the IVP SDK's own; nothing is converted here.
// Every floating-point operation order is kept so that results stay bit-identical.

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <limits>
#include <map>
#include <memory>
#include <utility>
#include <vector>

#include <ivp_actuator.hxx>
#include <ivp_actuator_spring.hxx>
#include <ivp_ball.hxx>
#include <ivp_collision_filter.hxx>
#include <ivp_compact_surface.hxx>
#include <ivp_constraint.hxx>
#include <ivp_controller.hxx>
#include <ivp_controller_factory.hxx>
#include <ivp_core.hxx>
#include <ivp_environment.hxx>
#include <ivp_listener_collision.hxx>
#include <ivp_material.hxx>
#include <ivp_polygon.hxx>
#include <ivp_real_object.hxx>
#include <ivp_surbuild_ledge_soup.hxx>
#include <ivp_surbuild_pointsoup.hxx>
#include <ivp_surman_polygon.hxx>
#include <ivp_template_constraint.hxx>
#include <ivp_templates.hxx>
#include <ivu_linear.hxx>
#include <ivu_vector.hxx>

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#define IVP_BRIDGE_EXPORT EMSCRIPTEN_KEEPALIVE
#else
#define IVP_BRIDGE_EXPORT
#endif

namespace {

constexpr int kAbiVersion = 7;
constexpr int kEventRowValues = 14;
constexpr double kDeltaPsiSeconds = 1.0 / 66.0;
constexpr int kBodyDescriptorValues = 18;
constexpr int kJointDescriptorValues = 9;
constexpr int kSpringDescriptorValues = 10;
constexpr int kForceDescriptorValues = 7;
constexpr int kImpulseAtValues = 6;
constexpr int kContactValues = 7;
constexpr int kMinHullVertices = 4;
constexpr int kMaxHullVertices = 100000;
constexpr int kMaxHulls = 1000;
constexpr int kMinCompoundLength = 13;
constexpr int kMaxCompoundLength = 3001000;
constexpr int kMaxTriangles = 1000000;
constexpr double kMinAxisLengthSquared = 1e-16;
constexpr double kMinForceDirectionLengthSquared = 1e-4;

constexpr int kEventFrictionCreated = 1;
constexpr int kEventFrictionDeleted = 2;
constexpr int kEventPostCollision = 3;

constexpr int kJointHinge = 1;
constexpr int kJointSlider = 2;
constexpr int kJointBallSocket = 3;

// Attribution: the force controller below is adapted from the CKBuildingBlocks
// PhysicsForce implementation (Apache-2.0). The notice is kept in THIRD_PARTY.md.
class OriginalForce : public IVP_Controller_Independent {
  public:
    OriginalForce(IVP_Real_Object *object, const IVP_U_Point *point_cs, const IVP_U_Point *impulse_ws)
        : core_(object->get_core()), point_cs_(*point_cs), impulse_ws_(*impulse_ws)
    {
        IVP_Controller_Manager::add_controller_to_core(this, core_);
    }

    ~OriginalForce() override
    {
        if (core_)
        {
            IVP_Controller_Manager::remove_controller_from_core(this, core_);
        }
    }

    void core_is_going_to_be_deleted_event(IVP_Core *deleted) override
    {
        if (deleted != core_)
        {
            return;
        }
        IVP_Controller_Manager::remove_controller_from_core(this, core_);
        core_ = nullptr;
    }

    void do_simulation_controller(IVP_Event_Sim *event, IVP_U_Vector<IVP_Core> *core_list) override
    {
        if (!core_ || !core_list || core_list->len() == 0)
        {
            return;
        }
        IVP_Environment *environment = event->environment;

        IVP_U_Matrix m_world_f_core;
        core_->calc_at_matrix(environment->get_current_time(), &m_world_f_core);

        // Direction only: the inverse rotation is the transpose of the rotational part.
        IVP_U_Matrix3 rotation_core_f_world;
        rotation_core_f_world.set_transpose3(&m_world_f_core);
        IVP_U_Point impulse_cs;
        rotation_core_f_world.vmult3(&impulse_ws_, &impulse_cs);

        IVP_U_Float_Point point_f;
        point_f.set(&point_cs_);
        IVP_U_Float_Point force_cs_f;
        force_cs_f.set(&impulse_cs);
        IVP_U_Float_Point force_ws_f;
        force_ws_f.set(&impulse_ws_);

        core_->async_push_core(&point_f, &force_cs_f, &force_ws_f);
    }

    IVP_CONTROLLER_PRIORITY get_controller_priority() override { return IVP_CP_ACTUATOR; }

  private:
    IVP_Core *core_;
    IVP_U_Point point_cs_;
    IVP_U_Point impulse_ws_;
};

bool allFinite(const double *values, int count)
{
    for (int i = 0; i < count; ++i)
    {
        if (!std::isfinite(values[i]))
        {
            return false;
        }
    }
    return true;
}

bool groupFits(const char *group)
{
    return !group || std::strlen(group) < IVP_NO_COLL_GROUP_STRING_LEN;
}

bool validBodyDescriptor(const double *d)
{
    if (!d || !allFinite(d, kBodyDescriptorValues))
    {
        return false;
    }
    const double quat_len2 = d[3] * d[3] + d[4] * d[4] + d[5] * d[5] + d[6] * d[6];
    if (!(quat_len2 > 0.999 && quat_len2 < 1.001))
    {
        return false;
    }
    return d[7] > 0.0 && d[8] >= 0.0 && d[9] >= 0.0 && d[9] <= 1.0 && d[10] >= 0.0 && d[11] >= 0.0;
}

int bodyIdOf(const IVP_Real_Object *object)
{
    if (!object)
    {
        return 0;
    }
    return static_cast<int>(reinterpret_cast<std::uintptr_t>(object->client_data));
}

// Points are copied into storage that the point list refers to; the list is
// only needed for the duration of the conversion.
IVP_Compact_Ledge *convexLedgeOf(std::vector<IVP_U_Point> &points)
{
    IVP_U_Vector<IVP_U_Point> list;
    for (IVP_U_Point &point : points)
    {
        list.add(&point);
    }
    return IVP_SurfaceBuilder_Pointsoup::convert_pointsoup_to_compact_ledge(&list);
}

struct ContactRecord
{
    int id;
    int first;
    int second;
};

struct JointRecord
{
    IVP_Constraint *constraint;
    int reference;
    int attached;
};

struct SpringRecord
{
    IVP_Actuator_Spring *spring;
    int reference;
    int attached;
};

struct ForceRecord
{
    OriginalForce *force;
    int body;
};

using BodyPair = std::pair<IVP_Real_Object *, IVP_Real_Object *>;

// One physics environment with every object it created. Owns all of them.
class PhysicsWorld : public IVP_Listener_Collision
{
  public:
    explicit PhysicsWorld(double gravity_y)
        : IVP_Listener_Collision(IVP_LISTENER_COLLISION_CALLBACK_FRICTION | IVP_LISTENER_COLLISION_CALLBACK_POST_COLLISION)
    {
        auto *meta_filter = new IVP_Meta_Collision_Filter(IVP_TRUE);
        pair_filter_ = new IVP_Collision_Filter_Exclusive_Pair();
        auto *group_filter = new IVP_Collision_Filter_Coll_Group_Ident(IVP_TRUE);
        meta_filter->add_collision_filter(pair_filter_);
        meta_filter->add_collision_filter(group_filter);
        app_env_.collision_filter = meta_filter;

        env_ = IVP_Environment_Manager::get_environment_manager()->create_environment(&app_env_, "Ballance web physics audit", 0);
        if (!env_)
        {
            return;
        }
        IVP_U_Point gravity(0.0, gravity_y, 0.0);
        env_->set_gravity(&gravity);
        env_->set_delta_PSI_time(kDeltaPsiSeconds);
        env_->add_listener_collision_global(this);
    }

    ~PhysicsWorld() override
    {
        if (env_)
        {
            env_->remove_listener_collision_global(this);
        }
        for (ForceRecord &record : forces_)
        {
            delete record.force;
        }
        for (SpringRecord &record : springs_)
        {
            delete record.spring;
        }
        for (JointRecord &record : joints_)
        {
            delete record.constraint;
        }
        delete env_;
        env_ = nullptr;

        managers_.clear();
        for (IVP_Compact_Surface *surface : surfaces_)
        {
            if (surface)
            {
                ivp_free_aligned(surface);
            }
        }
        surfaces_.clear();
    }

    PhysicsWorld(const PhysicsWorld &) = delete;
    PhysicsWorld &operator=(const PhysicsWorld &) = delete;

    bool valid() const { return env_ != nullptr; }

    double now() { return env_->get_current_time().get_time(); }

    IVP_Real_Object *body(int id) const
    {
        if (id < 1 || id > static_cast<int>(bodies_.size()))
        {
            return nullptr;
        }
        return bodies_[static_cast<size_t>(id - 1)];
    }

    void event_friction_created(IVP_Event_Friction *event) override
    {
        IVP_Contact_Situation *situation = event->contact_situation;
        const ContactRecord record{next_contact_id_++, bodyIdOf(situation->objects[0]), bodyIdOf(situation->objects[1])};
        contacts_[event->friction_handle] = record;
        appendRow(kEventFrictionCreated, timeOf(event->environment), record.id, record.first, record.second,
                  &situation->surf_normal, &situation->contact_point_ws, nullptr);
    }

    void event_friction_deleted(IVP_Event_Friction *event) override
    {
        auto found = contacts_.find(event->friction_handle);
        if (found == contacts_.end())
        {
            return;
        }
        const ContactRecord record = found->second;
        appendRow(kEventFrictionDeleted, timeOf(event->environment), record.id, record.first, record.second,
                  nullptr, nullptr, nullptr);
        contacts_.erase(found);
    }

    void event_post_collision(IVP_Event_Collision *event) override
    {
        IVP_Contact_Situation *situation = event->contact_situation;
        appendRow(kEventPostCollision, timeOf(event->environment), 0, bodyIdOf(situation->objects[0]),
                  bodyIdOf(situation->objects[1]), &situation->surf_normal, &situation->contact_point_ws,
                  &situation->speed);
    }

    static double timeOf(IVP_Environment *environment) { return environment->get_current_time().get_time(); }

    // One event row: kind, time, contact id, two body ids, then optional detail.
    void appendRow(int kind, double time, int contact, int first, int second, const IVP_U_Float_Point *normal,
                   const IVP_U_Point *point, const IVP_U_Float_Point *speed)
    {
        double row[kEventRowValues] = {static_cast<double>(kind), time, static_cast<double>(contact),
                                       static_cast<double>(first), static_cast<double>(second),
                                       0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0};
        if (normal)
        {
            for (int i = 0; i < 3; ++i)
            {
                row[5 + i] = normal->k[i];
            }
        }
        if (point)
        {
            for (int i = 0; i < 3; ++i)
            {
                row[8 + i] = point->k[i];
            }
        }
        if (speed)
        {
            for (int i = 0; i < 3; ++i)
            {
                row[11 + i] = speed->k[i];
            }
        }
        events_.insert(events_.end(), row, row + kEventRowValues);
    }

    // Builds a rigid body from a body descriptor. A null surface makes a ball of the given radius.
    int createBody(const double *d, IVP_SurfaceManager *surface, double radius, const char *group)
    {
        IVP_Template_Real_Object templ;
        templ.mass = d[7];
        templ.physical_unmoveable = d[12] != 0.0 ? IVP_TRUE : IVP_FALSE;
        templ.speed_damp_factor = d[10];
        templ.rot_speed_damp_factor.set(d[11], d[11], d[11]);
        templ.set_nocoll_group_ident(group ? group : "");

        auto material = std::make_unique<IVP_Material_Simple>(d[8], d[9]);
        templ.material = material.get();

        IVP_U_Matrix mass_center;
        mass_center.init();
        mass_center.vv.set(d[13], d[14], d[15]);
        templ.mass_center_override = &mass_center;

        IVP_U_Quat orientation;
        orientation.x = d[3];
        orientation.y = d[4];
        orientation.z = d[5];
        orientation.w = d[6];
        IVP_U_Point position(d[0], d[1], d[2]);

        IVP_Real_Object *object = nullptr;
        if (surface)
        {
            object = env_->create_polygon(surface, &templ, &orientation, &position);
        }
        else
        {
            IVP_Template_Ball ball;
            ball.radius = static_cast<IVP_FLOAT>(radius);
            object = env_->create_ball(&ball, &templ, &orientation, &position);
        }
        if (!object)
        {
            return 0;
        }

        materials_.push_back(std::move(material));
        bodies_.push_back(object);
        const int id = static_cast<int>(bodies_.size());
        object->client_data = reinterpret_cast<void *>(static_cast<std::uintptr_t>(id));

        object->enable_collision_detection(d[16] != 0.0 ? IVP_TRUE : IVP_FALSE);
        if (d[12] == 0.0 && d[17] == 0.0)
        {
            object->ensure_in_simulation();
        }
        return id;
    }

    // Compiles the ledges collected in the builder and creates one body on the resulting surface.
    int finishSurface(IVP_SurfaceBuilder_Ledge_Soup &builder, const double *d, const char *group)
    {
        IVP_Compact_Surface *surface = builder.compile();
        if (!surface)
        {
            return 0;
        }
        surfaces_.push_back(surface);
        auto manager = std::make_unique<IVP_SurfaceManager_Polygon>(surface);
        IVP_SurfaceManager *manager_ptr = manager.get();
        managers_.push_back(std::move(manager));
        return createBody(d, manager_ptr, 0.0, group);
    }

    IVP_Environment *env_ = nullptr;
    IVP_Application_Environment app_env_;
    IVP_Collision_Filter_Exclusive_Pair *pair_filter_ = nullptr;
    std::vector<IVP_Real_Object *> bodies_;
    std::vector<std::unique_ptr<IVP_Material_Simple>> materials_;
    std::vector<IVP_Compact_Surface *> surfaces_;
    std::vector<std::unique_ptr<IVP_SurfaceManager_Polygon>> managers_;
    std::vector<JointRecord> joints_;
    std::vector<SpringRecord> springs_;
    std::vector<ForceRecord> forces_;
    std::vector<BodyPair> excluded_;
    std::vector<double> events_;
    std::map<IVP_Contact_Point *, ContactRecord> contacts_;
    int next_contact_id_ = 1;
};

} // namespace

extern "C" {

IVP_BRIDGE_EXPORT int ivp_bridge_abi()
{
    return kAbiVersion;
}

IVP_BRIDGE_EXPORT PhysicsWorld *ivp_new(double gravity)
{
    if (!std::isfinite(gravity))
    {
        return nullptr;
    }
    auto *world = new PhysicsWorld(gravity);
    if (!world->valid())
    {
        delete world;
        return nullptr;
    }
    return world;
}

IVP_BRIDGE_EXPORT void ivp_delete(PhysicsWorld *world)
{
    delete world;
}

IVP_BRIDGE_EXPORT double ivp_time(PhysicsWorld *world)
{
    if (!world)
    {
        return std::numeric_limits<double>::quiet_NaN();
    }
    return world->now();
}

IVP_BRIDGE_EXPORT int ivp_event_count(PhysicsWorld *world)
{
    if (!world)
    {
        return -1;
    }
    return static_cast<int>(world->events_.size() / kEventRowValues);
}

// Copies every pending event row and clears the log. Failure leaves the log unchanged.
IVP_BRIDGE_EXPORT int ivp_events(PhysicsWorld *world, double *output, int capacity)
{
    if (!world)
    {
        return -1;
    }
    const int rows = static_cast<int>(world->events_.size() / kEventRowValues);
    if (capacity < rows || (!output && rows > 0))
    {
        return -1;
    }
    if (rows > 0)
    {
        std::copy(world->events_.begin(), world->events_.end(), output);
    }
    world->events_.clear();
    return rows;
}

// Lists the active friction contacts that involve one body, sorted by contact id.
// A null output returns the count only.
IVP_BRIDGE_EXPORT int ivp_contacts(PhysicsWorld *world, int body, double *output, int capacity)
{
    if (!world || !world->body(body) || capacity < 0)
    {
        return -1;
    }
    std::vector<std::pair<IVP_Contact_Point *, ContactRecord>> rows;
    for (const auto &entry : world->contacts_)
    {
        if (entry.second.first == body || entry.second.second == body)
        {
            rows.emplace_back(entry.first, entry.second);
        }
    }
    std::sort(rows.begin(), rows.end(),
              [](const std::pair<IVP_Contact_Point *, ContactRecord> &a,
                 const std::pair<IVP_Contact_Point *, ContactRecord> &b) { return a.second.id < b.second.id; });

    const int count = static_cast<int>(rows.size());
    if (!output)
    {
        return count;
    }
    if (capacity < count)
    {
        return -1;
    }
    for (int row = 0; row < count; ++row)
    {
        IVP_Contact_Point *handle = rows[static_cast<size_t>(row)].first;
        const ContactRecord &record = rows[static_cast<size_t>(row)].second;
        IVP_U_Float_Point normal;
        IVP_Contact_Point_API::get_surface_normal_ws(handle, &normal);

        double *out = output + row * kContactValues;
        out[0] = record.id;
        out[1] = record.first;
        out[2] = record.second;
        out[3] = normal.k[0];
        out[4] = normal.k[1];
        out[5] = normal.k[2];
        out[6] = IVP_Contact_Point_API::get_vert_force(handle);
    }
    return count;
}

IVP_BRIDGE_EXPORT int ivp_ball(PhysicsWorld *world, double radius, const double *descriptor, const char *group)
{
    if (!world || !validBodyDescriptor(descriptor) || !std::isfinite(radius) || !(radius > 0.0) || !groupFits(group))
    {
        return 0;
    }
    return world->createBody(descriptor, nullptr, radius, group);
}

IVP_BRIDGE_EXPORT int ivp_hull(PhysicsWorld *world, int count, const double *vertices, const double *descriptor,
                               const char *group)
{
    if (!world || !validBodyDescriptor(descriptor) || !vertices || count < kMinHullVertices ||
        count > kMaxHullVertices || !groupFits(group) || !allFinite(vertices, 3 * count))
    {
        return 0;
    }
    std::vector<IVP_U_Point> points;
    points.reserve(static_cast<size_t>(count));
    for (int i = 0; i < count; ++i)
    {
        points.emplace_back(vertices[3 * i], vertices[3 * i + 1], vertices[3 * i + 2]);
    }
    IVP_Compact_Ledge *ledge = convexLedgeOf(points);
    if (!ledge)
    {
        return 0;
    }
    IVP_SurfaceBuilder_Ledge_Soup builder;
    builder.insert_ledge(ledge);
    return world->finishSurface(builder, descriptor, group);
}

// Faces that cannot be converted are skipped; the rest form one body.
IVP_BRIDGE_EXPORT int ivp_trimesh(PhysicsWorld *world, int faces, const double *triangles, const double *descriptor,
                                  const char *group)
{
    if (!world || !validBodyDescriptor(descriptor) || !triangles || faces < 1 || faces > kMaxTriangles ||
        !groupFits(group) || !allFinite(triangles, 9 * faces))
    {
        return 0;
    }
    IVP_SurfaceBuilder_Ledge_Soup builder;
    int accepted = 0;
    for (int face = 0; face < faces; ++face)
    {
        const double *t = triangles + 9 * face;
        IVP_U_Point p0(t[0], t[1], t[2]);
        IVP_U_Point p1(t[3], t[4], t[5]);
        IVP_U_Point p2(t[6], t[7], t[8]);
        IVP_Compact_Ledge *ledge = IVP_SurfaceBuilder_Pointsoup::convert_triangle_to_compace_ledge(&p0, &p1, &p2);
        if (ledge)
        {
            builder.insert_ledge(ledge);
            ++accepted;
        }
    }
    if (accepted == 0)
    {
        return 0;
    }
    return world->finishSurface(builder, descriptor, group);
}

// Packed input: for each hull, a point count stored as a double, then x, y, z triples.
IVP_BRIDGE_EXPORT int ivp_compound(PhysicsWorld *world, int hulls, int length, const double *packed,
                                   const double *descriptor, const char *group)
{
    if (!world || !validBodyDescriptor(descriptor) || !packed || !group || !groupFits(group) || hulls < 1 ||
        hulls > kMaxHulls || length < kMinCompoundLength || length > kMaxCompoundLength)
    {
        return 0;
    }

    // Validation pass: every hull must fit exactly into the packed length.
    int offset = 0;
    for (int hull = 0; hull < hulls; ++hull)
    {
        if (offset >= length)
        {
            return 0;
        }
        const double declared = packed[offset];
        if (!std::isfinite(declared) || declared < kMinHullVertices || declared > kMaxHullVertices ||
            declared != std::floor(declared))
        {
            return 0;
        }
        const int count = static_cast<int>(declared);
        const int values = 3 * count;
        if (offset + 1 + values > length || !allFinite(packed + offset + 1, values))
        {
            return 0;
        }
        offset += 1 + values;
    }
    if (offset != length)
    {
        return 0;
    }

    // Build pass: every hull becomes one ledge of a shared ledge-soup builder.
    IVP_SurfaceBuilder_Ledge_Soup builder;
    offset = 0;
    for (int hull = 0; hull < hulls; ++hull)
    {
        const int count = static_cast<int>(packed[offset]);
        const double *coords = packed + offset + 1;
        std::vector<IVP_U_Point> points;
        points.reserve(static_cast<size_t>(count));
        for (int i = 0; i < count; ++i)
        {
            points.emplace_back(coords[3 * i], coords[3 * i + 1], coords[3 * i + 2]);
        }
        IVP_Compact_Ledge *ledge = convexLedgeOf(points);
        if (!ledge)
        {
            return 0;
        }
        builder.insert_ledge(ledge);
        offset += 1 + 3 * count;
    }
    return world->finishSurface(builder, descriptor, group);
}

IVP_BRIDGE_EXPORT int ivp_group(PhysicsWorld *world, int body, const char *group)
{
    IVP_Real_Object *object = world ? world->body(body) : nullptr;
    if (!object || !group || !groupFits(group))
    {
        return 0;
    }
    object->change_nocoll_group_ident(group);
    object->recheck_collision_filter();
    return 1;
}

// Removes a body together with the pairs, forces, springs and joints that reference it.
IVP_BRIDGE_EXPORT int ivp_remove(PhysicsWorld *world, int body)
{
    IVP_Real_Object *object = world ? world->body(body) : nullptr;
    if (!object)
    {
        return 0;
    }

    for (auto it = world->excluded_.begin(); it != world->excluded_.end();)
    {
        if (it->first == object || it->second == object)
        {
            world->pair_filter_->enable_collision_between_objects(it->first, it->second);
            it = world->excluded_.erase(it);
        }
        else
        {
            ++it;
        }
    }

    for (ForceRecord &record : world->forces_)
    {
        if (record.body == body && record.force)
        {
            delete record.force;
            record.force = nullptr;
        }
    }
    for (SpringRecord &record : world->springs_)
    {
        if (record.spring && (record.reference == body || record.attached == body))
        {
            delete record.spring;
            record.spring = nullptr;
        }
    }
    // The bridge releases each joint before its body, so no stale constraint handle remains.
    for (JointRecord &record : world->joints_)
    {
        if (record.constraint && (record.reference == body || record.attached == body))
        {
            delete record.constraint;
            record.constraint = nullptr;
        }
    }

    object->delete_silently();
    world->bodies_[static_cast<size_t>(body - 1)] = nullptr;
    return 1;
}

IVP_BRIDGE_EXPORT int ivp_pair(PhysicsWorld *world, int first, int second, int enabled)
{
    if (!world || first == second)
    {
        return 0;
    }
    IVP_Real_Object *object_a = world->body(first);
    IVP_Real_Object *object_b = world->body(second);
    if (!object_a || !object_b)
    {
        return 0;
    }
    if (first > second)
    {
        std::swap(object_a, object_b);
    }

    const BodyPair key(object_a, object_b);
    if (enabled)
    {
        world->pair_filter_->enable_collision_between_objects(object_a, object_b);
        auto found = std::find(world->excluded_.begin(), world->excluded_.end(), key);
        if (found != world->excluded_.end())
        {
            world->excluded_.erase(found);
        }
    }
    else
    {
        world->pair_filter_->disable_collision_between_objects(object_a, object_b);
        if (std::find(world->excluded_.begin(), world->excluded_.end(), key) == world->excluded_.end())
        {
            world->excluded_.push_back(key);
        }
    }
    object_a->recheck_collision_filter();
    object_b->recheck_collision_filter();
    return 1;
}

IVP_BRIDGE_EXPORT int ivp_wake(PhysicsWorld *world, int body)
{
    IVP_Real_Object *object = world ? world->body(body) : nullptr;
    if (!object)
    {
        return 0;
    }
    object->ensure_in_simulation();
    return 1;
}

// Kinds: 1 hinge, 2 slider, 3 ball-and-socket. Reference zero means world space.
IVP_BRIDGE_EXPORT int ivp_joint(PhysicsWorld *world, int kind, int reference, int attached, const double *descriptor)
{
    if (!world || !descriptor || (kind != kJointHinge && kind != kJointSlider && kind != kJointBallSocket) ||
        reference == attached)
    {
        return 0;
    }
    IVP_Real_Object *object_r = nullptr;
    IVP_Real_Object *object_a = nullptr;
    if (reference != 0)
    {
        object_r = world->body(reference);
        if (!object_r)
        {
            return 0;
        }
    }
    if (attached != 0)
    {
        object_a = world->body(attached);
        if (!object_a)
        {
            return 0;
        }
    }
    const bool movable_r = object_r && !object_r->get_core()->physical_unmoveable;
    const bool movable_a = object_a && !object_a->get_core()->physical_unmoveable;
    if (!movable_r && !movable_a)
    {
        return 0;
    }
    if (!allFinite(descriptor, kJointDescriptorValues))
    {
        return 0;
    }
    const double axis_len2 = descriptor[3] * descriptor[3] + descriptor[4] * descriptor[4] + descriptor[5] * descriptor[5];
    if (kind != kJointBallSocket && axis_len2 < kMinAxisLengthSquared)
    {
        return 0;
    }
    const bool limits = descriptor[6] != 0.0;
    if (limits && (kind == kJointBallSocket || descriptor[7] > descriptor[8]))
    {
        return 0;
    }

    IVP_U_Point anchor(descriptor[0], descriptor[1], descriptor[2]);
    IVP_U_Point axis(descriptor[3], descriptor[4], descriptor[5]);
    IVP_Template_Constraint tmpl;
    if (kind == kJointHinge)
    {
        tmpl.set_hinge_ws(object_r, &anchor, &axis, object_a);
        if (limits)
        {
            tmpl.limit_rotation_axis(IVP_INDEX_Z, static_cast<IVP_FLOAT>(descriptor[7]), static_cast<IVP_FLOAT>(descriptor[8]));
        }
    }
    else if (kind == kJointSlider)
    {
        // The order of these two calls is significant.
        tmpl.set_constraint_ws(object_r, &anchor, &axis, 3, 2, object_a, nullptr);
        tmpl.set_constraint_ws(object_r, &anchor, &axis, 2, 3, object_a, nullptr);
        if (limits)
        {
            tmpl.limit_translation_axis(IVP_INDEX_Z, static_cast<IVP_FLOAT>(descriptor[7]), static_cast<IVP_FLOAT>(descriptor[8]));
        }
    }
    else
    {
        tmpl.set_ballsocket_ws(object_r, &anchor, object_a);
    }

    IVP_Constraint *constraint = IVP_Controller_Factory::create_constraint(world->env_, &tmpl);
    if (!constraint)
    {
        return 0;
    }
    world->joints_.push_back(JointRecord{constraint, reference, attached});
    return static_cast<int>(world->joints_.size());
}

IVP_BRIDGE_EXPORT int ivp_remove_joint(PhysicsWorld *world, int joint)
{
    if (!world || joint < 1 || joint > static_cast<int>(world->joints_.size()))
    {
        return 0;
    }
    JointRecord &record = world->joints_[static_cast<size_t>(joint - 1)];
    if (!record.constraint)
    {
        return 0;
    }
    delete record.constraint;
    record.constraint = nullptr;
    return 1;
}

IVP_BRIDGE_EXPORT int ivp_spring(PhysicsWorld *world, int reference, int attached, const double *descriptor)
{
    if (!world || !descriptor || reference == attached)
    {
        return 0;
    }
    IVP_Real_Object *object_r = world->body(reference);
    IVP_Real_Object *object_a = world->body(attached);
    if (!object_r || !object_a)
    {
        return 0;
    }
    if (object_r->get_core()->physical_unmoveable && object_a->get_core()->physical_unmoveable)
    {
        return 0;
    }
    if (!allFinite(descriptor, kSpringDescriptorValues) || descriptor[6] < 0.0 || descriptor[7] < 0.0 ||
        descriptor[8] < 0.0 || descriptor[9] < 0.0)
    {
        return 0;
    }

    IVP_U_Point anchor_r(descriptor[0], descriptor[1], descriptor[2]);
    IVP_U_Point anchor_a(descriptor[3], descriptor[4], descriptor[5]);
    IVP_Template_Anchor template_anchor_r;
    IVP_Template_Anchor template_anchor_a;
    template_anchor_r.set_anchor_position_ws(object_r, &anchor_r);
    template_anchor_a.set_anchor_position_ws(object_a, &anchor_a);

    IVP_Template_Spring tmpl;
    tmpl.anchors[0] = &template_anchor_r;
    tmpl.anchors[1] = &template_anchor_a;
    tmpl.spring_len = static_cast<IVP_FLOAT>(descriptor[6]);
    tmpl.spring_constant = static_cast<IVP_FLOAT>(descriptor[7]);
    tmpl.spring_damp = static_cast<IVP_FLOAT>(descriptor[8]);
    tmpl.rel_pos_damp = static_cast<IVP_FLOAT>(descriptor[9]);
    tmpl.spring_values_are_relative = IVP_FALSE;
    tmpl.spring_force_only_on_stretch = IVP_FALSE;
    tmpl.max_len_exceed_type = IVP_SFE_NONE;

    IVP_Actuator_Spring *spring = IVP_Controller_Factory::create_spring(world->env_, &tmpl);
    if (!spring)
    {
        return 0;
    }
    world->springs_.push_back(SpringRecord{spring, reference, attached});
    return static_cast<int>(world->springs_.size());
}

IVP_BRIDGE_EXPORT int ivp_remove_spring(PhysicsWorld *world, int spring)
{
    if (!world || spring < 1 || spring > static_cast<int>(world->springs_.size()))
    {
        return 0;
    }
    SpringRecord &record = world->springs_[static_cast<size_t>(spring - 1)];
    if (!record.spring)
    {
        return 0;
    }
    delete record.spring;
    record.spring = nullptr;
    return 1;
}

// Layout: 0-2 application point, 3-5 direction (world), 6 magnitude.
// The point is in core space when corePoint is non-zero, otherwise it is given in world space.
IVP_BRIDGE_EXPORT int ivp_force(PhysicsWorld *world, int body, int corePoint, const double *descriptor)
{
    IVP_Real_Object *object = world ? world->body(body) : nullptr;
    if (!object || !descriptor || object->get_core()->physical_unmoveable ||
        !allFinite(descriptor, kForceDescriptorValues))
    {
        return 0;
    }

    double direction[3] = {descriptor[3], descriptor[4], descriptor[5]};
    const double direction_len2 = direction[0] * direction[0] + direction[1] * direction[1] + direction[2] * direction[2];
    if (direction_len2 <= kMinForceDirectionLengthSquared)
    {
        direction[0] = 1.0;
        direction[1] = 0.0;
        direction[2] = 0.0;
    }
    else
    {
        const double direction_len = std::sqrt(direction_len2);
        direction[0] /= direction_len;
        direction[1] /= direction_len;
        direction[2] /= direction_len;
    }
    const double magnitude = descriptor[6];
    IVP_U_Point impulse(direction[0] * magnitude, direction[1] * magnitude, direction[2] * magnitude);

    IVP_U_Point point(descriptor[0], descriptor[1], descriptor[2]);
    if (corePoint == 0)
    {
        IVP_U_Matrix m_world_f_core;
        object->get_core()->calc_at_matrix(world->env_->get_current_time(), &m_world_f_core);
        IVP_U_Matrix m_core_f_world;
        if (m_core_f_world.real_invert(&m_world_f_core) != IVP_OK)
        {
            return 0;
        }
        IVP_U_Point point_cs;
        m_core_f_world.vmult4(&point, &point_cs);
        point = point_cs;
    }

    auto *force = new OriginalForce(object, &point, &impulse);
    world->forces_.push_back(ForceRecord{force, body});
    return static_cast<int>(world->forces_.size());
}

IVP_BRIDGE_EXPORT int ivp_remove_force(PhysicsWorld *world, int force)
{
    if (!world || force < 1 || force > static_cast<int>(world->forces_.size()))
    {
        return 0;
    }
    ForceRecord &record = world->forces_[static_cast<size_t>(force - 1)];
    if (!record.force)
    {
        return 0;
    }
    delete record.force;
    record.force = nullptr;
    return 1;
}

// The interval is passed unchanged; the environment sub-steps internally.
IVP_BRIDGE_EXPORT int ivp_step(PhysicsWorld *world, double dt)
{
    if (!world || !std::isfinite(dt) || !(dt > 0.0))
    {
        return 0;
    }
    world->env_->simulate_dtime(dt);
    return 1;
}

// Asynchronous world-space push at the geometric centre of the body.
IVP_BRIDGE_EXPORT int ivp_push(PhysicsWorld *world, int body, double x, double y, double z)
{
    IVP_Real_Object *object = world ? world->body(body) : nullptr;
    const double values[3] = {x, y, z};
    if (!object || !allFinite(values, 3))
    {
        return 0;
    }
    IVP_U_Float_Point impulse(x, y, z);
    IVP_U_Point center;
    object->get_geom_center_world_space(&center);
    object->async_push_object_ws(&center, &impulse);
    return 1;
}

// Layout: 0-2 point of application (world), 3-5 impulse.
IVP_BRIDGE_EXPORT int ivp_push_at(PhysicsWorld *world, int body, const double *values)
{
    IVP_Real_Object *object = world ? world->body(body) : nullptr;
    if (!object || !values || !allFinite(values, kImpulseAtValues))
    {
        return 0;
    }
    IVP_U_Point point(values[0], values[1], values[2]);
    IVP_U_Float_Point impulse(values[3], values[4], values[5]);
    object->async_push_object_ws(&point, &impulse);
    return 1;
}

// Output (17 doubles): 0-2 position, 3-6 orientation x y z w (at the interpolated time),
// 7-9 core speed, 10-12 core rotation speed, 13-15 rotational inertia, 16 movement state.
IVP_BRIDGE_EXPORT int ivp_state(PhysicsWorld *world, int body, double *output)
{
    IVP_Real_Object *object = world ? world->body(body) : nullptr;
    if (!object || !output)
    {
        return 0;
    }
    IVP_U_Quat orientation;
    IVP_U_Point position;
    object->get_quat_world_f_object_AT(&orientation, &position);

    const IVP_Core *core = object->get_core();
    const IVP_U_Float_Point *inertia = core->get_rot_inertia();
    for (int i = 0; i < 3; ++i)
    {
        output[i] = position.k[i];
        output[7 + i] = core->speed.k[i];
        output[10 + i] = core->rot_speed.k[i];
        output[13 + i] = inertia->k[i];
    }
    output[3] = orientation.x;
    output[4] = orientation.y;
    output[5] = orientation.z;
    output[6] = orientation.w;
    output[16] = static_cast<double>(object->get_movement_state());
    return 1;
}

} // extern "C"
