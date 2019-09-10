const GraphQLJSON = require('graphql-type-json');
const fs = require('fs');
const gql = require('graphql-tag');
const flattenDeep = require('lodash.flattendeep');
const fastMemoize = require('fast-memoize');
const { print } = require('graphql/language/printer');
const { graphql } = require('graphql');
const {
  resolveAllKeys,
  arrayToObject,
  mapKeys,
  objMerge,
  flatten,
  unique,
} = require('@keystone-alpha/utils');
const {
  validateFieldAccessControl,
  validateListAccessControl,
} = require('@keystone-alpha/access-control');
const {
  startAuthedSession,
  endAuthedSession,
  commonSessionMiddleware,
} = require('@keystone-alpha/session');

const {
  unmergeRelationships,
  createRelationships,
  mergeRelationships,
} = require('./relationship-utils');
const List = require('../List');
const { DEFAULT_DIST_DIR } = require('../../constants');

const debugGraphQLSchemas = () => !!process.env.DEBUG_GRAPHQL_SCHEMAS;

module.exports = class Keystone {
  constructor({
    defaultAccess,
    adapters,
    adapter,
    defaultAdapter,
    name,
    adapterConnectOptions = {},
    onConnect,
    cookieSecret = 'qwerty',
    sessionStore,
  }) {
    this.name = name;
    this.adapterConnectOptions = adapterConnectOptions;
    this.defaultAccess = { list: true, field: true, ...defaultAccess };
    this.auth = {};
    this.lists = {};
    this.listsArray = [];
    this.getListByKey = key => this.lists[key];
    this._extendedTypes = [];
    this._extendedQueries = [];
    this._extendedMutations = [];
    this._graphQLQuery = {};
    this._cookieSecret = cookieSecret;
    this._sessionStore = sessionStore;
    this.registeredTypes = new Set();
    this.eventHandlers = { onConnect };

    if (adapters) {
      this.adapters = adapters;
      this.defaultAdapter = defaultAdapter;
    } else if (adapter) {
      this.adapters = { [adapter.constructor.name]: adapter };
      this.defaultAdapter = adapter.constructor.name;
    } else {
      throw new Error('Need an adapter, yo');
    }

    // Placeholder until keystone.prepare() is run during which this function
    // will be replaced with one that can actually make queries (assuming the
    // graphql app is setup, which is checked for elsewhere).
    this.executeQuery = () => {
      throw new Error(
        'Attempted to execute keystone.query() before keystone.prepare() has completed.'
      );
    };
  }

  getCookieSecret() {
    if (!this._cookieSecret) {
      throw new Error('No cookieSecret set in Keystone constructor');
    }
    return this._cookieSecret;
  }

  // The GraphQL App uses this method to build up the context required for each
  // incoming query.
  // It is also used for generating the `keystone.query` method
  getGraphQlContext({ schemaName = 'admin', req = {}, skipAccessControl = false } = {}) {
    let getListAccessControlForUser;
    let getFieldAccessControlForUser;

    if (skipAccessControl) {
      getListAccessControlForUser = () => true;
      getFieldAccessControlForUser = () => true;
    } else {
      // memoizing to avoid requests that hit the same type multiple times.
      // We do it within the request callback so we can resolve it based on the
      // request info ( like who's logged in right now, etc)
      getListAccessControlForUser = fastMemoize((listKey, originalInput, operation) => {
        return validateListAccessControl({
          access: this.lists[listKey].access['public'],
          originalInput,
          operation,
          authentication: { item: req.user, listKey: req.authedListKey },
          listKey,
        });
      });

      getFieldAccessControlForUser = fastMemoize(
        (listKey, fieldKey, originalInput, existingItem, operation) => {
          return validateFieldAccessControl({
            access: this.lists[listKey].fieldsByPath[fieldKey].access['public'],
            originalInput,
            existingItem,
            operation,
            authentication: { item: req.user, listKey: req.authedListKey },
            fieldKey,
            listKey,
          });
        }
      );
    }

    return {
      schemaName,
      startAuthedSession: ({ item, list }, audiences) =>
        startAuthedSession(req, { item, list }, audiences, this._cookieSecret),
      endAuthedSession: endAuthedSession.bind(null, req),
      authedItem: req.user,
      authedListKey: req.authedListKey,
      getListAccessControlForUser,
      getFieldAccessControlForUser,
    };
  }

  /**
   * A factory for generating executable graphql query functions.
   *
   * @param context Object The graphQL Context object
   * @param context.schemaName String Usually 'admin', this is the registered
   * schema as passed to keystone.registerSchema()
   *
   * @return Function An executable function for running a query
   */
  _buildQueryHelper(defaultContext) {
    /**
     * An executable function for running a query
     *
     * @param queryString String A graphQL query string
     * @param options.skipAccessControl Boolean By default access control _of
     * the user making the initial request_ is still tested. Disable all
     * Access Control checks with this flag
     * @param options.variables Object The variables passed to the graphql
     * query for the given queryString.
     * @param options.context Object Overrides to the default context used when
     * making a query. Useful for setting the `schemaName` for example.
     *
     * @return Promise<Object> The graphql query response
     */
    return (queryString, { skipAccessControl = false, variables, context = {} } = {}) => {
      let passThroughContext = {
        ...defaultContext,
        ...context,
      };

      if (skipAccessControl) {
        passThroughContext.getListAccessControlForUser = () => true;
        passThroughContext.getFieldAccessControlForUser = () => true;
      }

      const graphQLQuery = this._graphQLQuery[passThroughContext.schemaName];

      if (!graphQLQuery) {
        return Promise.reject(
          new Error(
            `No executable schema named '${passThroughContext.schemaName}' is available. Have you setup '@keystone-alpha/app-graphql'?`
          )
        );
      }

      return graphQLQuery(queryString, passThroughContext, variables);
    };
  }

  createAuthStrategy(options) {
    const { type: StrategyType, list: listKey, config } = options;
    const { authType } = StrategyType;
    if (!this.auth[listKey]) {
      this.auth[listKey] = {};
    }
    const strategy = new StrategyType(this, listKey, config);
    strategy.authType = authType;
    this.auth[listKey][authType] = strategy;
    return strategy;
  }

  createList(key, config, { isAuxList = false } = {}) {
    const { getListByKey, adapters } = this;
    const adapterName = config.adapterName || this.defaultAdapter;
    const compose = fns => o => fns.reduce((acc, fn) => fn(acc), o);

    const list = new List(key, compose(config.plugins || [])(config), {
      getListByKey,
      queryHelper: this._buildQueryHelper.bind(this),
      adapter: adapters[adapterName],
      defaultAccess: this.defaultAccess,
      getAuth: () => this.auth[key] || {},
      registerType: type => this.registeredTypes.add(type),
      isAuxList,
      createAuxList: (auxKey, auxConfig) => {
        if (isAuxList) {
          throw new Error(
            `Aux list "${key}" shouldn't be creating more aux lists ("${auxKey}"). Something's probably not right here.`
          );
        }
        return this.createList(auxKey, auxConfig, { isAuxList: true });
      },
    });
    this.lists[key] = list;
    this.listsArray.push(list);
    list.initFields();
    return list;
  }

  extendGraphQLSchema({ types = [], queries = [], mutations = [] }) {
    this._extendedTypes = this._extendedTypes.concat(types);
    this._extendedQueries = this._extendedQueries.concat(queries);
    this._extendedMutations = this._extendedMutations.concat(mutations);
  }

  /**
   * @return Promise<null>
   */
  connect() {
    const { adapters, name } = this;
    return resolveAllKeys(mapKeys(adapters, adapter => adapter.connect({ name }))).then(() => {
      if (this.eventHandlers.onConnect) {
        return this.eventHandlers.onConnect(this);
      }
    });
  }

  /**
   * @return Promise<null>
   */
  disconnect() {
    return resolveAllKeys(
      mapKeys(this.adapters, adapter => adapter.disconnect())
      // Chain an empty function so that the result of this promise
      // isn't unintentionally leaked to the caller
    ).then(() => {});
  }

  getAdminMeta() {
    const schemaName = 'public';
    // We've consciously made a design choice that the `read` permission on a
    // list is a master switch in the Admin UI (not the GraphQL API).
    // Justification: If you want to Create without the Read permission, you
    // technically don't have permission to read the result of your creation.
    // If you want to Update an item, you can't see what the current values
    // are. If you want to delete an item, you'd need to be given direct
    // access to it (direct URI), but can't see anything about that item. And
    // in fact, being able to load a page with a 'delete' button on it
    // violates the read permission as it leaks the fact that item exists.
    // In all these cases, the Admin UI becomes unnecessarily complex.
    // So we only allow all these actions if you also have read access.
    const lists = arrayToObject(
      this.listsArray.filter(list => list.access[schemaName].read && !list.isAuxList),
      'key',
      list => list.getAdminMeta()
    );

    return { lists, name: this.name };
  }

  getTypeDefs() {
    const schemaName = 'public';
    // Aux lists are only there for typing and internal operations, they should
    // not have any GraphQL operations performed on them
    const firstClassLists = this.listsArray.filter(list => !list.isAuxList);

    // Fields can be represented multiple times within and between lists.
    // If a field defines a `getGqlAuxTypes()` method, it will be
    // duplicated.
    // graphql-tools will blow up (rightly so) on duplicated types.
    // Deduping here avoids that problem.
    return [
      ...unique(flatten(this.listsArray.map(list => list.getGqlTypes({ schemaName })))),
      ...unique(this._extendedTypes),
      `"""NOTE: Can be JSON, or a Boolean/Int/String
          Why not a union? GraphQL doesn't support a union including a scalar
          (https://github.com/facebook/graphql/issues/215)"""
       scalar JSON`,
      `type _ListAccess {
          """Access Control settings for the currently logged in (or anonymous)
             user when performing 'create' operations.
             NOTE: 'create' can only return a Boolean.
             It is not possible to specify a declarative Where clause for this
             operation"""
          create: Boolean

          """Access Control settings for the currently logged in (or anonymous)
             user when performing 'read' operations."""
          read: JSON

          """Access Control settings for the currently logged in (or anonymous)
             user when performing 'update' operations."""
          update: JSON

          """Access Control settings for the currently logged in (or anonymous)
             user when performing 'delete' operations."""
          delete: JSON
       }`,
      `type _ListSchemaRelatedFields {
        """The typename as used in GraphQL queries"""
        type: String

        """A list of GraphQL field names"""
        fields: [String]
      }`,
      `type _ListSchema {
        """The typename as used in GraphQL queries"""
        type: String

        """Top level GraphQL query names which either return this type, or
           provide aggregate information about this type"""
        queries: [String]

        """Information about fields on other types which return this type, or
           provide aggregate information about this type"""
        relatedFields: [_ListSchemaRelatedFields]
      }`,
      `type _ListMeta {
        """The Keystone List name"""
        name: String

        """Access control configuration for the currently authenticated
           request"""
        access: _ListAccess

        """Information on the generated GraphQL schema"""
        schema: _ListSchema
       }`,
      `type _QueryMeta {
          count: Int
       }`,
      `type Query {
          ${unique(
            flatten([
              ...firstClassLists.map(list => list.getGqlQueries({ schemaName })),
              this._extendedQueries.map(({ schema }) => schema),
            ])
          ).join('\n')}
          """ Retrieve the meta-data for all lists. """
          _ksListsMeta: [_ListMeta]
       }`,
      `type Mutation {
          ${unique(
            flatten([
              ...firstClassLists.map(list => list.getGqlMutations({ schemaName })),
              this._extendedMutations.map(({ schema }) => schema),
            ])
          ).join('\n')}
       }`,
    ].map(s => print(gql(s)));
  }

  // It's not Keystone core's responsibility to create an executable schema, but
  // once one is, Keystone wants to be able to expose the ability to query that
  // schema, so this function enables other modules to register that function.
  registerSchema(schemaName, schema) {
    this._graphQLQuery[schemaName] = (query, context, variables) =>
      graphql(schema, query, null, context, variables);
  }

  getAdminSchema() {
    const schemaName = 'public';
    const typeDefs = this.getTypeDefs();
    if (debugGraphQLSchemas()) {
      typeDefs.forEach(i => console.log(i));
    }

    const queryMetaResolver = {
      // meta is passed in from the list's resolver (eg; '_allUsersMeta')
      count: meta => meta.getCount(),
    };

    const listMetaResolver = {
      // meta is passed in from the list's resolver (eg; '_allUsersMeta')
      access: meta => meta.getAccess(),
      // schema is
      schema: meta => meta.getSchema(),
    };

    const listAccessResolver = {
      // access is passed in from the listMetaResolver
      create: access => access.getCreate(),
      read: access => access.getRead(),
      update: access => access.getUpdate(),
      delete: access => access.getDelete(),
    };

    // Aux lists are only there for typing and internal operations, they should
    // not have any GraphQL operations performed on them
    const firstClassLists = this.listsArray.filter(list => !list.isAuxList);

    // NOTE: some fields are passed through unchanged from the list, and so are
    // not specified here.
    const listSchemaResolver = {
      // A function so we can lazily evaluate this potentially expensive
      // operation
      // (Could we memoize this in the future?)
      // NOTE: We purposely include the list we're looking for as it may have a
      // self-referential field (eg: User { friends: [User] })
      relatedFields: ({ key }) =>
        firstClassLists
          .map(list => ({
            type: list.gqlNames.outputTypeName,
            fields: flatten(
              list
                .getFieldsRelatedTo(key)
                .filter(field => field.access[schemaName].read)
                .map(field => Object.keys(field.gqlOutputFieldResolvers({ schemaName })))
            ),
          }))
          .filter(({ fields }) => fields.length),
    };

    // Like the `typeDefs`, we want to dedupe the resolvers. We rely on the
    // semantics of the JS spread operator here (duplicate keys are overridden
    // - first one wins)
    // TODO: Document this order of precendence, because it's not obvious, and
    // there's no errors thrown
    // TODO: console.warn when duplicate keys are detected?
    const customResolver = ({ schema, resolver }) => {
      const name = gql(`type t { ${schema} }`).definitions[0].fields[0].name.value;
      return {
        [name]: (obj, args, context, info) =>
          resolver(obj, args, context, info, { query: this._buildQueryHelper(context) }),
      };
    };
    const resolvers = {
      // Order of spreading is important here - we don't want user-defined types
      // to accidentally override important things like `Query`.
      ...objMerge(this.listsArray.map(list => list.gqlAuxFieldResolvers({ schemaName }))),
      ...objMerge(this.listsArray.map(list => list.gqlFieldResolvers({ schemaName }))),

      JSON: GraphQLJSON,

      _QueryMeta: queryMetaResolver,
      _ListMeta: listMetaResolver,
      _ListAccess: listAccessResolver,
      _ListSchema: listSchemaResolver,

      Query: {
        // Order is also important here, any TypeQuery's defined by types
        // shouldn't be able to override list-level queries
        ...objMerge(firstClassLists.map(list => list.gqlAuxQueryResolvers())),
        ...objMerge(firstClassLists.map(list => list.gqlQueryResolvers({ schemaName }))),
        // And the Keystone meta queries must always be available
        _ksListsMeta: (_, args, context) =>
          this.listsArray
            .filter(list => list.access[schemaName].read)
            .map(list => list.listMeta(context)),
        ...objMerge(this._extendedQueries.map(customResolver)),
      },

      Mutation: {
        ...objMerge(firstClassLists.map(list => list.gqlAuxMutationResolvers())),
        ...objMerge(firstClassLists.map(list => list.gqlMutationResolvers({ schemaName }))),
        ...objMerge(this._extendedMutations.map(customResolver)),
      },
    };

    if (debugGraphQLSchemas()) {
      console.log(resolvers);
    }

    return {
      typeDefs: typeDefs.map(
        typeDef =>
          gql`
            ${typeDef}
          `
      ),
      resolvers,
    };
  }

  dumpSchema(file) {
    // The 'Upload' scalar is normally automagically added by Apollo Server
    // See: https://blog.apollographql.com/file-uploads-with-apollo-server-2-0-5db2f3f60675
    // Since we don't execute apollo server over this schema, we have to
    // reinsert it.
    const schema = `
      scalar Upload
      ${this.getTypeDefs().join('\n')}
    `;
    fs.writeFileSync(file, schema);
  }

  createItem(listKey, itemData) {
    return this.lists[listKey].adapter.create(itemData);
  }

  async createItems(itemsToCreate) {
    // 1. Split it apart
    const { relationships, data } = unmergeRelationships(this.lists, itemsToCreate);
    // 2. Create the items
    // NOTE: Only works if all relationships fields are non-"required"
    const createdItems = await resolveAllKeys(
      mapKeys(data, (items, listKey) =>
        Promise.all(items.map(itemData => this.createItem(listKey, itemData)))
      )
    );

    let createdRelationships;
    try {
      // 3. Create the relationships
      createdRelationships = await createRelationships(this.lists, relationships, createdItems);
    } catch (error) {
      // 3.5. If creation of relationships didn't work, unwind the createItems
      Promise.all(
        Object.entries(createdItems).map(([listKey, items]) =>
          Promise.all(items.map(({ id }) => this.lists[listKey].adapter.delete(id)))
        )
      );
      // Re-throw the error now that we've cleaned up
      throw error;
    }

    // 4. Merge the data back together again
    return mergeRelationships(createdItems, createdRelationships);
  }

  async prepare({ dev = false, apps = [], distDir } = {}) {
    const middlewares = flattenDeep([
      // Used by other middlewares such as authentication strategies. Important
      // to be first so the methods added to `req` are available further down
      // the request pipeline.
      commonSessionMiddleware(this, this._cookieSecret, this._sessionStore),
      ...(await Promise.all(
        [
          // Inject any field middlewares (eg; WYSIWIG's static assets)
          // We do this first to avoid it conflicting with any catch-all routes the
          // user may have specified
          ...this.registeredTypes,
          ...flattenDeep(
            Object.values(this.auth).map(authStrategies => Object.values(authStrategies))
          ),
          ...apps,
        ]
          .filter(({ prepareMiddleware } = {}) => !!prepareMiddleware)
          .map(app =>
            app.prepareMiddleware({
              keystone: this,
              dev,
              distDir: distDir || DEFAULT_DIST_DIR,
            })
          )
      )),
    ]).filter(middleware => !!middleware);

    // Now that the middlewares are done, it's safe to assume all the schemas
    // are registered, so we can setup our query helper
    // This enables god-mode queries with no access control checks
    this.executeQuery = this._buildQueryHelper(this.getGraphQlContext({ skipAccessControl: true }));

    return { middlewares };
  }
};
