const express = require("express");
const bodyParser = require("body-parser");
const { sequelize } = require("./model");
const { getProfile } = require("./middleware/getProfile");
const app = express();
app.use(bodyParser.json());
app.set("sequelize", sequelize);
app.set("models", sequelize.models);

const { Op } = require("sequelize");

/**
 * @returns contract by id
 */
app.get("/contracts/:id", getProfile, async (req, res) => {
    const { Contract } = req.app.get("models");
    const { id } = req.params;
    const contract = await Contract.findOne({
        where: {
            id: id,
            [Op.or]: [{ ContractorId: req.profile.id }, { ClientId: req.profile.id }],
        },
    });
    if (!contract) return res.status(404).end();
    res.json(contract);
});

/**
 * @returns contracts
 */
app.get("/contracts", getProfile, async (req, res) => {
    const { Contract } = req.app.get("models");
    const { id } = req.params;
    const contracts = await Contract.findAll({
        where: {
            [Op.or]: [{ ContractorId: req.profile.id }, { ClientId: req.profile.id }],
        },
    });
    if (!contracts) return res.status(404).end();
    res.json(contracts);
});

/**
 * @returns jobs
 */
app.get("/jobs/unpaid", getProfile, async (req, res) => {
    const { Job, Contract } = req.app.get("models");
    const jobs = await Job.findAll({
        where: {
            paid: null,
        },
        include: [
            {
                model: Contract,
                where: {
                    [Op.or]: [
                        { ContractorId: req.profile.id },
                        { ClientId: req.profile.id },
                    ],
                    status: "in_progress",
                },
            },
        ],
    });
    if (!jobs) return res.status(404).end();
    res.json(jobs);
});

/**
 * @returns OK
 */
app.post("/jobs/:job_id/pay", getProfile, async (req, res) => {
    const { Profile, Job, Contract } = req.app.get("models");
    const { job_id } = req.params;
    const job = await Job.findOne({
        where: {
            id: job_id,
            paid: null,
        },
        include: [
            {
                model: Contract,
                where: {
                    ClientId: req.profile.id,
                    status: "in_progress",
                },
                include: [
                    {
                        model: Profile,
                        as: "Contractor",
                    },
                ],
            },
        ],
    });
    if (!job) return res.status(404).end();
    if (job.price > req.profile.balance) return res.status(400).end();

    try {
        // Here I make a sample of a concurrent transaction
        await sequelize.transaction(async (t1) => {
            await sequelize.transaction(async (t2) => {
                Promise.all([
                    await Profile.update(
                        {
                            balance: req.profile.balance - job.price,
                        },
                        {
                            where: {
                                id: req.profile.id,
                            },
                        },
                        { transaction: t1 }
                    ),
                    await Profile.update(
                        {
                            balance: job.Contract.Contractor.balance + job.price,
                        },
                        {
                            where: {
                                id: job.Contract.ContractorId,
                            },
                        },
                        { transaction: t1 }
                    ),
                    await Job.update(
                        {
                            paid: true,
                            paymentDate: new Date(),
                        },
                        {
                            where: {
                                id: job_id,
                            },
                        },
                        { transaction: t2 }
                    ),
                ]);
            });
        });
        res.status(200).end();
    } catch (error) {
        res.status(500).end();
    }
});

/**
 * @returns OK
 */
app.post("/balances/deposit/:userId", getProfile, async (req, res) => {
    const { Profile, Job, Contract } = req.app.get("models");
    const { userId } = req.params;
    const { deposit } = req.body;
    const jobs = await Job.findAll({
        where: {
            paid: null,
        },
        include: [
            {
                model: Contract,
                where: {
                    ClientId: userId,
                    status: "in_progress",
                },
            },
        ],
    });
    const totalJobsDebt = jobs.reduce((acc, job) => acc + job.price, 0);
    const depositLimit = totalJobsDebt * 0.25;
    if (deposit > depositLimit) return res.status(400).end();
    try {
        await sequelize.transaction(async (t) => {
            const client = await Profile.findOne(
                {
                    where: {
                        id: userId,
                    },
                },
                { transaction: t }
            );
            await Profile.update(
                {
                    balance: client.balance + deposit,
                },
                {
                    where: {
                        id: userId,
                    },
                },
                { transaction: t }
            );
        });
        res.status(200).end();
    } catch (error) {
        res.status(500).end();
    }
});

/**
 * @returns professions
 */
app.get(
    "/admin/best-profession",
    getProfile,
    async (req, res) => {
        const { start, end } = req.query;
        const { Profile, Job, Contract } = req.app.get("models");
        const professions = await Job.findAll({
            where: {
                paid: true,
                paymentDate: {
                    [Op.between]: [start, end],
                },
            },
            include: [
                {
                    model: Contract,
                    include: [
                        {
                            model: Profile,
                            as: "Contractor",
                            attributes: ["profession"]
                        }
                    ],
                    attributes: ['ContractorId']
                },
            ],
            attributes: [
                'Contract.Contractor.profession',
                [sequelize.fn('sum', sequelize.col('price')), 'total_amount'],
            ],
            group: ['Contract.Contractor.profession'],
            order: [['total_amount', 'DESC']],
        });
        if (!professions) return res.status(404).end();
        const result = professions.map(profession => {
            return {
                profession: profession.Contract.Contractor.profession,
                jobs_paid_sum: profession.dataValues.total_amount
            }
        })
        res.json(result);
    }
);

/**
 * @returns clients
 */
app.get(
    "/admin/best-clients",
    getProfile,
    async (req, res) => {
        const { start, end, limit} = req.query;
        const { Profile, Job, Contract } = req.app.get("models");
        const clients = await Job.findAll({
            where: {
                paid: true,
                paymentDate: {
                    [Op.between]: [start, end],
                },
            },
            include: [
                {
                    model: Contract,
                    include: [
                        {
                            model: Profile,
                            as: "Client",
                            attributes: ["firstName","lastName"]
                        }
                    ],
                    attributes: ['ClientId']
                },
            ],
            attributes: [
                'Contract.Client.id',
                [sequelize.fn('sum', sequelize.col('price')), 'total_amount'],
            ],
            group: ['Contract.Client.id'],
            order: [['total_amount', 'DESC']],
            limit: limit || 2       
        });
        if (!clients) return res.status(404).end();
        const result = clients.map(client => {
            return {
                id: client.Contract.ClientId,
                fullName: `${client.Contract.Client.firstName} ${client.Contract.Client.lastName}`,
                paid: client.dataValues.total_amount
            }
        })
        res.json(result);
    }
);

module.exports = app;
