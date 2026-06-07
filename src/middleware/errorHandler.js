const Joi = require('joi');

const schemas = {
  createBox: Joi.object({
    box_no: Joi.string().required().messages({
      'string.empty': '箱号不能为空',
      'any.required': '箱号是必填项'
    }),
    batch_no: Joi.string().required().messages({
      'string.empty': '批次号不能为空',
      'any.required': '批次号是必填项'
    }),
    kitchen_staff: Joi.string().required().messages({
      'string.empty': '厨房操作人员不能为空',
      'any.required': '厨房操作人员是必填项'
    }),
    meal_items: Joi.array().items(
      Joi.object({
        name: Joi.string().required(),
        quantity: Joi.number().integer().min(1).required(),
        price: Joi.number().min(0).optional()
      })
    ).min(1).required().messages({
      'array.min': '至少需要包含一份餐品',
      'any.required': '餐品列表是必填项'
    })
  }),

  statusUpdate: Joi.object({
    operator: Joi.string().required().messages({
      'string.empty': '操作人不能为空',
      'any.required': '操作人是必填项'
    }),
    operator_type: Joi.string().valid('KITCHEN', 'DRIVER', 'STORE', 'QC', 'SYSTEM').required().messages({
      'any.only': '操作人类型必须是 KITCHEN, DRIVER, STORE, QC, SYSTEM 之一',
      'any.required': '操作人类型是必填项'
    }),
    new_custodian: Joi.string().optional(),
    new_custodian_type: Joi.string().valid('KITCHEN', 'DRIVER', 'STORE', 'QC', 'SYSTEM').optional(),
    temperature: Joi.number().optional(),
    timestamp: Joi.string().optional(),
    remark: Joi.string().optional(),
    exception_reason: Joi.string().optional(),
    is_exception: Joi.boolean().optional()
  }),

  temperatureRecord: Joi.object({
    box_no: Joi.string().required(),
    temperature: Joi.number().required().messages({
      'number.base': '温度必须为有效数字',
      'any.required': '温度是必填项'
    }),
    timestamp: Joi.string().required().messages({
      'string.empty': '时间戳不能为空',
      'any.required': '时间戳是必填项'
    }),
    recorded_by: Joi.string().required().messages({
      'string.empty': '记录人不能为空',
      'any.required': '记录人是必填项'
    })
  }),

  exportRequest: Joi.object({
    operator: Joi.string().required().messages({
      'string.empty': '操作人不能为空',
      'any.required': '操作人是必填项'
    })
  }),

  correctionSubmit: Joi.object({
    box_no: Joi.string().required().messages({
      'string.empty': '箱号不能为空',
      'any.required': '箱号是必填项'
    }),
    record_type: Joi.string().valid('status_history', 'temperature', 'box').required().messages({
      'any.only': '记录类型必须是 status_history, temperature, box 之一',
      'any.required': '记录类型是必填项'
    }),
    record_id: Joi.number().integer().min(1).optional().messages({
      'number.base': '记录ID必须为正整数'
    }),
    field_name: Joi.string().required().messages({
      'string.empty': '更正字段名不能为空',
      'any.required': '更正字段名是必填项'
    }),
    proposed_value: Joi.alternatives().try(Joi.string(), Joi.number()).required().messages({
      'any.required': '更正后的值是必填项'
    }),
    apply_reason: Joi.string().required().messages({
      'string.empty': '更正原因不能为空',
      'any.required': '更正原因是必填项'
    }),
    applicant: Joi.string().required().messages({
      'string.empty': '申请人不能为空',
      'any.required': '申请人是必填项'
    }),
    applicant_type: Joi.string().valid('KITCHEN', 'DRIVER', 'STORE', 'QC').required().messages({
      'any.only': '申请人类型必须是 KITCHEN, DRIVER, STORE, QC 之一',
      'any.required': '申请人类型是必填项'
    })
  }),

  correctionReview: Joi.object({
    reviewer: Joi.string().required().messages({
      'string.empty': '审核人不能为空',
      'any.required': '审核人是必填项'
    }),
    reviewer_type: Joi.string().valid('QC').required().messages({
      'any.only': '审核人类型必须是 QC',
      'any.required': '审核人类型是必填项'
    }),
    review_result: Joi.string().valid('APPROVED', 'REJECTED').required().messages({
      'any.only': '审核结果必须是 APPROVED 或 REJECTED',
      'any.required': '审核结果是必填项'
    }),
    review_reason: Joi.string().required().messages({
      'string.empty': '审核意见不能为空',
      'any.required': '审核意见是必填项'
    })
  })
};

function validate(schemaName) {
  return (req, res, next) => {
    const schema = schemas[schemaName];
    if (!schema) {
      return res.status(500).json({
        success: false,
        error: '验证规则未定义: ' + schemaName
      });
    }

    const { error, value } = schema.validate(req.body, {
      abortEarly: false,
      stripUnknown: true
    });

    if (error) {
      const errors = error.details.map(d => d.message);
      return res.status(400).json({
        success: false,
        error: '参数验证失败',
        details: errors
      });
    }

    req.validatedBody = value;
    next();
  };
}

function errorHandler(err, req, res, next) {
  console.error('Error:', err);

  if (err.name === 'AppError') {
    return res.status(err.code || 400).json({
      success: false,
      error: err.message
    });
  }

  if (err.name === 'ValidationError') {
    return res.status(400).json({
      success: false,
      error: err.message
    });
  }

  if (err.code === 'SQLITE_CONSTRAINT') {
    return res.status(400).json({
      success: false,
      error: '数据约束违反，可能是重复值或关联数据不存在'
    });
  }

  res.status(500).json({
    success: false,
    error: '服务器内部错误',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
}

function notFoundHandler(req, res) {
  res.status(404).json({
    success: false,
    error: '接口不存在: ' + req.method + ' ' + req.path,
    available_endpoints: [
      'GET    /api/health',
      'GET    /api/config',
      'GET    /api/configs',
      'POST   /api/config',
      'GET    /api/boxes',
      'GET    /api/boxes/:box_no',
      'POST   /api/boxes',
      'PUT    /api/boxes/:box_no/status/:status',
      'POST   /api/temperature',
      'GET    /api/audit-logs',
      'GET    /api/exceptions',
      'POST   /api/export/handover/:box_no',
      'POST   /api/export/exceptions',
      'GET    /api/export/:doc_no',
      'GET    /api/export-history',
      'POST   /api/corrections',
      'GET    /api/corrections',
      'GET    /api/corrections/:id',
      'PUT    /api/corrections/:id/review',
      'GET    /api/corrections/batch/:batch_no/status',
      'GET    /api/meta/correction-statuses'
    ]
  });
}

function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = {
  validate,
  errorHandler,
  notFoundHandler,
  asyncHandler
};
