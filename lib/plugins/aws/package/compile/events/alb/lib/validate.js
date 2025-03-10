'use strict';

const _ = require('lodash');

// eslint-disable-next-line max-len
const CIDR_IPV6_PATTERN = /^s*((([0-9A-Fa-f]{1,4}:){7}([0-9A-Fa-f]{1,4}|:))|(([0-9A-Fa-f]{1,4}:){6}(:[0-9A-Fa-f]{1,4}|((25[0-5]|2[0-4]d|1dd|[1-9]?d)(.(25[0-5]|2[0-4]d|1dd|[1-9]?d)){3})|:))|(([0-9A-Fa-f]{1,4}:){5}(((:[0-9A-Fa-f]{1,4}){1,2})|:((25[0-5]|2[0-4]d|1dd|[1-9]?d)(.(25[0-5]|2[0-4]d|1dd|[1-9]?d)){3})|:))|(([0-9A-Fa-f]{1,4}:){4}(((:[0-9A-Fa-f]{1,4}){1,3})|((:[0-9A-Fa-f]{1,4})?:((25[0-5]|2[0-4]d|1dd|[1-9]?d)(.(25[0-5]|2[0-4]d|1dd|[1-9]?d)){3}))|:))|(([0-9A-Fa-f]{1,4}:){3}(((:[0-9A-Fa-f]{1,4}){1,4})|((:[0-9A-Fa-f]{1,4}){0,2}:((25[0-5]|2[0-4]d|1dd|[1-9]?d)(.(25[0-5]|2[0-4]d|1dd|[1-9]?d)){3}))|:))|(([0-9A-Fa-f]{1,4}:){2}(((:[0-9A-Fa-f]{1,4}){1,5})|((:[0-9A-Fa-f]{1,4}){0,3}:((25[0-5]|2[0-4]d|1dd|[1-9]?d)(.(25[0-5]|2[0-4]d|1dd|[1-9]?d)){3}))|:))|(([0-9A-Fa-f]{1,4}:){1}(((:[0-9A-Fa-f]{1,4}){1,6})|((:[0-9A-Fa-f]{1,4}){0,4}:((25[0-5]|2[0-4]d|1dd|[1-9]?d)(.(25[0-5]|2[0-4]d|1dd|[1-9]?d)){3}))|:))|(:(((:[0-9A-Fa-f]{1,4}){1,7})|((:[0-9A-Fa-f]{1,4}){0,5}:((25[0-5]|2[0-4]d|1dd|[1-9]?d)(.(25[0-5]|2[0-4]d|1dd|[1-9]?d)){3}))|:)))(%.+)?s*(\/([0-9]|[1-9][0-9]|1[0-1][0-9]|12[0-8]))$/;
const CIDR_IPV4_PATTERN = /^([0-9]{1,3}\.){3}[0-9]{1,3}(\/([0-9]|[1-2][0-9]|3[0-2]))$/;
// see https://docs.aws.amazon.com/general/latest/gr/aws-arns-and-namespaces.html#arn-syntax-elb-application
const ALB_LISTENER_PATTERN = /^arn:aws[\w-]*:elasticloadbalancing:.+:listener\/app\/[\w-]+\/([\w-]+)\/([\w-]+)$/;

module.exports = {
  validate() {
    const authorizers = {};
    const albAuthConfig = this.serverless.service.provider.alb;
    if (albAuthConfig) {
      for (const [name, auth] of _.entries(albAuthConfig.authorizers)) {
        switch (auth.type) {
          case 'cognito':
          case 'oidc':
            authorizers[name] = this.validateAlbAuth(auth);
            break;
          default:
            throw new this.serverless.classes.Error(
              `Authorizer type "${auth.type}" not supported. Only "cognito" and "oidc" are supported`
            );
        }
      }
    }

    const events = [];

    _.forEach(this.serverless.service.functions, (functionObject, functionName) => {
      functionObject.events.forEach(event => {
        if (event.alb) {
          if (_.isObject(event.alb)) {
            const { albId, listenerId } = this.validateListenerArn(
              event.alb.listenerArn,
              functionName
            );
            const albObj = {
              // This is set to the ALB ID if the listener ARNs are provided as strings,
              // or the listener logical ID if listenerARNs are given as refs
              albId,
              listenerId,
              listenerArn: event.alb.listenerArn,
              priority: event.alb.priority,
              conditions: {
                // concat usage allows the user to provide value as a string or an array
                path: [].concat(event.alb.conditions.path),
              },
              // the following is data which is not defined on the event-level
              functionName,
            };
            if (event.alb.conditions.host) {
              albObj.conditions.host = [].concat(event.alb.conditions.host);
            }
            if (event.alb.conditions.method) {
              albObj.conditions.method = [].concat(event.alb.conditions.method);
            }
            if (event.alb.conditions.header) {
              albObj.conditions.header = this.validateHeaderCondition(event, functionName);
            }
            if (event.alb.conditions.query) {
              albObj.conditions.query = this.validateQueryCondition(event, functionName);
            }
            if (event.alb.conditions.ip) {
              albObj.conditions.ip = this.validateIpCondition(event, functionName);
            }
            if (event.alb.multiValueHeaders) {
              albObj.multiValueHeaders = event.alb.multiValueHeaders;
            }
            if (event.alb.authorizer) {
              albObj.authorizers = this.validateEventAuthorizers(event, authorizers, functionName);
            }
            if (event.alb.healthCheck) {
              albObj.healthCheck = this.validateAlbHealthCheck(event);
            }
            events.push(albObj);
          }
        }
      });
    });
    this.validatePriorities(events);

    return {
      events,
      authorizers,
    };
  },

  validateListenerArn(listenerArn, functionName) {
    if (!listenerArn) {
      throw new this.serverless.classes.Error(
        `listenerArn is missing in function "${functionName}".`
      );
    }
    // If the ARN is a ref, use the logical ID instead of the ALB ID
    if (_.isObject(listenerArn)) {
      if (listenerArn.Ref) {
        return { albId: listenerArn.Ref, listenerId: listenerArn.Ref };
      }
      throw new this.serverless.classes.Error(
        `Invalid ALB listenerArn in function "${functionName}".`
      );
    }
    const matches = listenerArn.match(ALB_LISTENER_PATTERN);
    if (!matches) {
      throw new this.serverless.classes.Error(
        `Invalid ALB listenerArn in function "${functionName}".`
      );
    }
    return { albId: matches[1], listenerId: matches[2] };
  },

  validateHeaderCondition(event, functionName) {
    const messageTitle = `Invalid ALB event "header" condition in function "${functionName}".`;
    if (
      !_.isObject(event.alb.conditions.header) ||
      !event.alb.conditions.header.name ||
      !event.alb.conditions.header.values
    ) {
      const errorMessage = [
        messageTitle,
        ' You must provide an object with "name" and "values" properties.',
      ].join('');
      throw new this.serverless.classes.Error(errorMessage);
    }
    if (!Array.isArray(event.alb.conditions.header.values)) {
      const errorMessage = [messageTitle, ' Property "values" must be an array.'].join('');
      throw new this.serverless.classes.Error(errorMessage);
    }
    return event.alb.conditions.header;
  },

  validateQueryCondition(event, functionName) {
    if (!_.isObject(event.alb.conditions.query)) {
      const errorMessage = [
        `Invalid ALB event "query" condition in function "${functionName}".`,
        ' You must provide an object.',
      ].join('');
      throw new this.serverless.classes.Error(errorMessage);
    }
    return event.alb.conditions.query;
  },

  validateIpCondition(event, functionName) {
    const cidrBlocks = [].concat(event.alb.conditions.ip);
    const allValuesAreCidr = cidrBlocks.every(
      cidr => CIDR_IPV4_PATTERN.test(cidr) || CIDR_IPV6_PATTERN.test(cidr)
    );

    if (!allValuesAreCidr) {
      const errorMessage = [
        `Invalid ALB event "ip" condition in function "${functionName}".`,
        ' You must provide values in a valid IPv4 or IPv6 CIDR format.',
      ].join('');
      throw new this.serverless.classes.Error(errorMessage);
    }
    return cidrBlocks;
  },

  validatePriorities(albEvents) {
    let comparator;
    let duplicates;
    const samePriority = (e1, e2) => e1.priority === e2.priority;
    const sameFunction = (e1, e2) => e1.functionName === e2.functionName;
    const sameListener = (e1, e2) => e1.listenerId === e2.listenerId;

    // For this special case, we need to let the user know
    // it is a Serverless limitation (but not an ALB limitation)
    comparator = (e1, e2) => samePriority(e1, e2) && !sameListener(e1, e2) && sameFunction(e1, e2);
    duplicates = _.difference(albEvents, _.uniqWith(albEvents, comparator));
    if (duplicates.length > 0) {
      const errorMessage = [
        `ALB event in function "${duplicates[0].functionName}"`,
        ` cannot use priority "${duplicates[0].priority}" because it is already in use.\n`,
        '  Events in the same function cannot use the same priority even if they have a different listenerArn.\n',
        '  This is a Serverless limitation that will be fixed in the next major release.',
      ].join('');
      throw new this.serverless.classes.Error(errorMessage);
    }

    comparator = (e1, e2) => samePriority(e1, e2) && sameListener(e1, e2) && !sameFunction(e1, e2);
    duplicates = _.difference(albEvents, _.uniqWith(albEvents, comparator));
    if (duplicates.length > 0) {
      const errorMessage = [
        `ALB event in function "${duplicates[0].functionName}"`,
        ` cannot use priority "${duplicates[0].priority}" because it is already in use.`,
      ].join('');
      throw new this.serverless.classes.Error(errorMessage);
    }
  },

  validateEventAuthorizers(event, authorizers, functionName) {
    const eventAuthorizers = Array.isArray(event.alb.authorizer)
      ? event.alb.authorizer
      : [event.alb.authorizer];
    for (const auth of eventAuthorizers) {
      if (!authorizers[auth]) {
        throw new this.serverless.classes.Error(
          `No match for "${auth}" in function "${functionName}" found in registered ALB authorizers`
        );
      }
    }
    return eventAuthorizers;
  },

  validateAlbAuth(auth) {
    const hasAllowUnauthenticated = auth.allowUnauthenticated != null;
    const hasOnUnauthenticatedRequest = auth.onUnauthenticatedRequest != null;

    if (hasAllowUnauthenticated && !hasOnUnauthenticatedRequest) {
      auth.onUnauthenticatedRequest = auth.allowUnauthenticated ? 'allow' : 'deny';
    } else {
      auth.onUnauthenticatedRequest = auth.onUnauthenticatedRequest || 'deny';
    }

    return auth;
  },

  validateAlbHealthCheck(event) {
    const eventHealthCheck = event.alb.healthCheck;
    if (_.isObject(eventHealthCheck)) {
      return Object.assign(eventHealthCheck, { enabled: true });
    }
    return { enabled: true };
  },
};
